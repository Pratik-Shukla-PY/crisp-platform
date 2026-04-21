// ── Privacy Consent Gate (shown after language detection so it appears in local language) ──
function _initConsentGate() {
    const CONSENT_KEY = 'crisp_privacy_consent';
    if (localStorage.getItem(CONSENT_KEY)) return;

    const overlay = document.getElementById('consent-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const checkbox = document.getElementById('consent-checkbox');
    const acceptBtn = document.getElementById('consent-accept-btn');

    checkbox.addEventListener('change', () => {
        acceptBtn.disabled = !checkbox.checked;
    });

    acceptBtn.addEventListener('click', () => {
        if (!checkbox.checked) return;
        localStorage.setItem(CONSENT_KEY, JSON.stringify({ accepted: true, ts: Date.now() }));
        overlay.style.display = 'none';
    });
}
// _initConsentGate() is called from DOMContentLoaded AFTER detectAndSetupLanguage() applies i18n

// ── Service Worker Registration ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Register SW relative to current path so it works regardless of serving root
        const swUrl = new URL('sw.js', window.location.href).href;
        navigator.serviceWorker.register(swUrl, { scope: './' })
            .then((reg) => {
                console.log('SW registered, scope:', reg.scope);
                setInterval(() => reg.update(), 60 * 60 * 1000);
            })
            .catch((err) => {
                console.warn('SW registration failed:', err);
            });
    });
}

// ── IndexedDB Offline Queue ──────────────────────────────────────────────────
const IDB_NAME = 'crisp-offline';
const IDB_VERSION = 1;
const IDB_STORE = 'pending-reports';

function openIDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB not available'));
        }
        const timeout = setTimeout(() => reject(new Error('IndexedDB open timeout')), 5000);
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: 'client_report_id' });
            }
        };
        req.onsuccess = () => { clearTimeout(timeout); resolve(req.result); };
        req.onerror = () => { clearTimeout(timeout); reject(req.error); };
        req.onblocked = () => { clearTimeout(timeout); reject(new Error('IndexedDB blocked')); };
    });
}

async function enqueueReport(payload) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        // Store ALL fields flat at top level — keyPath is client_report_id.
        // Previously nested under `payload` key which broke retry loop reads.
        tx.objectStore(IDB_STORE).put({
            ...payload,                            // all stage/media/meta fields at top level
            timestamp: Date.now(),
            retryCount: payload.retryCount || 0,  // preserve existing retry count
            status: 'queued'
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function dequeueReport(clientReportId) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(clientReportId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getAllQueued() {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function updateQueueItemStatus(clientReportId, status, retryCount) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const getReq = store.get(clientReportId);
        getReq.onsuccess = () => {
            const item = getReq.result;
            if (item) {
                item.status = status;
                if (retryCount !== undefined) item.retryCount = retryCount;
                store.put(item);
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ── Upload Progress Helpers ──────────────────────────────────────────────────
function sendWithProgress(url, payload) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                updateUploadProgress(pct, pct < 100 ? 'Uploading...' : 'Processing...');
            }
        });

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText));
            } else {
                reject(new Error(`HTTP ${xhr.status}`));
            }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timeout'));
        xhr.timeout = 120000; // 2min timeout for large payloads with audio

        xhr.send(JSON.stringify(payload));
    });
}

function showUploadOverlay(statusText) {
    const overlay = document.getElementById('upload-overlay');
    overlay.style.display = 'flex';
    document.getElementById('upload-status-text').textContent = statusText || t('upload_sending');
    document.getElementById('upload-progress-fill').style.width = '0%';
    document.getElementById('upload-progress-pct').textContent = '0%';
    const icon = document.getElementById('upload-status-icon');
    icon.className = 'upload-status-icon';
    icon.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>';
}

function updateUploadProgress(pct, statusText) {
    document.getElementById('upload-progress-fill').style.width = pct + '%';
    document.getElementById('upload-progress-pct').textContent = pct + '%';
    if (statusText) {
        document.getElementById('upload-status-text').textContent = statusText;
    }
}

function hideUploadOverlay() {
    document.getElementById('upload-overlay').style.display = 'none';
}

function showUploadSuccess() {
    const icon = document.getElementById('upload-status-icon');
    icon.className = 'upload-status-icon success';
    icon.innerHTML = '<i class="fa-solid fa-check"></i>';
    document.getElementById('upload-status-text').textContent = t('upload_success');
    updateUploadProgress(100);
    setTimeout(hideUploadOverlay, 1200);
}

function showUploadQueued() {
    // Same success animation as online — user shouldn't feel different
    showUploadSuccess();
}

// ── Sync Badge ───────────────────────────────────────────────────────────────
async function updateSyncBadge() {
    try {
        const badge = document.getElementById('sync-badge');
        const text = document.getElementById('sync-badge-text');
        const items = await getAllQueued();

        if (items.length === 0) {
            badge.style.display = 'none';
            return;
        }

        badge.style.display = 'flex';
        const syncing = items.filter(i => i.status === 'syncing').length;
        const failed = items.filter(i => i.status === 'failed').length;

        if (syncing > 0) {
            badge.className = 'sync-badge syncing';
            text.textContent = `${t('sync_syncing')} ${syncing}/${items.length}`;
        } else if (failed > 0) {
            badge.className = 'sync-badge error';
            text.textContent = `${items.length} ${t('sync_queued')} (${failed} ${t('sync_failed')})`;
        } else {
            badge.className = 'sync-badge';
            text.textContent = `${items.length} ${t('sync_queued')}`;
        }
    } catch (e) {
        console.warn('Sync badge update failed:', e);
    }
}

// ── Manual Sync Fallback (for browsers without Background Sync) ──────────────
async function syncQueueManual() {
    let items;
    try { items = await getAllQueued(); } catch (_) { return; }
    if (items.length === 0) return;

    console.log(`Manual sync: ${items.length} queued reports`);
    for (const item of items) {
        try {
            const stages = item.stages || {};
            let reportId = item.serverId || null;

            // Stage 1: metadata
            if (!stages.meta && item.meta) {
                const res = await fetch(`${API_BASE}/reports/meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item.meta)
                });
                if (res.ok) {
                    const data = await res.json();
                    reportId = data.id;
                    item.serverId = reportId;
                    item.stages.meta = true;
                    try { await enqueueReport(item); } catch (_) {}
                } else { continue; }
            }

            if (!reportId) continue;

            // Stage 2: text
            if (!stages.text && reportId) {
                try {
                    const res = await fetch(`${API_BASE}/reports/${reportId}/description`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ description: item.text || '' })
                    });
                    if (res.ok) { item.stages.text = true; try { await enqueueReport(item); } catch (_) {} }
                } catch (e) { _silent('sync.text', e); }
            }

            // Stage 3: photo
            if (!stages.photo && item.photo && reportId) {
                try {
                    const res = await fetch(`${API_BASE}/reports/${reportId}/media/attach`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'IMAGE', resolution_tier: 'MEDIUM', url: item.photo, file_size_bytes: item.photoSize || 0 })
                    });
                    if (res.ok) { item.stages.photo = true; item.photo = null; try { await enqueueReport(item); } catch (_) {} }
                } catch (e) { _silent('sync.photo', e); }
            }

            // Stage 3b: extra photos (multiple images)
            if (stages.photo && item.extraPhotos && item.extraPhotos.length > 0 && reportId) {
                for (let ei = 0; ei < item.extraPhotos.length; ei++) {
                    try {
                        const res = await fetch(`${API_BASE}/reports/${reportId}/media/attach`, {
                            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: 'IMAGE', resolution_tier: 'MEDIUM', url: item.extraPhotos[ei], file_size_bytes: 0 })
                        });
                        if (res.ok) { item.extraPhotos.splice(ei, 1); ei--; try { await enqueueReport(item); } catch(_){} }
                    } catch (e) { _silent('sync.extra-photo', e); }
                }
            }

            // Stage 4: audio
            if (!stages.audio && item.audioBlob && reportId) {
                try {
                    const res = await fetch(`${API_BASE}/reports/${reportId}/media/attach`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'AUDIO', resolution_tier: 'LOW', url: item.audioBlob, file_size_bytes: item.audioSize || 0 })
                    });
                    if (res.ok) { item.stages.audio = true; item.audioBlob = null; try { await enqueueReport(item); } catch (_) {} }
                } catch (e) { _silent('sync.audio', e); }
            }

            // All done?
            if (item.stages.meta && item.stages.text && item.stages.photo && item.stages.audio) {
                await dequeueReport(item.client_report_id);
            }
        } catch (e) {
            console.warn('Manual sync error for', item.client_report_id, e);
        }
    }
    updateSyncBadge();
}

// ── i18n strings ──────────────────────────────────────────────────────────────
// ── UNDP §3.1b — Async locale-JSON loader (Apr 2026) ─────────────────────────
//
// The inline I18N + EXTRA_LANG + UNDP_I18N_EXTRA dicts below are the SYNC
// first-paint baseline. They are intentionally kept because:
//   (a) First paint must not wait on a network round-trip.
//   (b) Service-worker caches may miss on a cold install.
//   (c) Tests + dev builds that don't serve the JSON files must still work.
//
// For denser, UNDP-aligned translations (232 content keys per UN locale),
// `mobile-app/src/i18n/{locale}.json` files are fetched asynchronously on
// every `activateLang(code)` call. The fetched pack is merged on top of the
// inline pack (JSON wins), then `applyI18n()` re-renders the DOM so users
// see the richer translations once they arrive — typically within ~100 ms
// on a warm cache.
//
// `_LOCALE_JSON_CACHE[code]` stores:
//    undefined  — never attempted.
//    Promise<T> — fetch in flight.
//    object     — loaded + merged once.
//    null       — fetch failed / 404 / parse error. Will not retry unless
//                 the page reloads.
const _LOCALE_JSON_CACHE = Object.create(null);

async function _loadLocaleJson(code) {
    if (!code) return null;
    // en.json is the canonical source of truth, but the inline I18N.en
    // pack is identical and already loaded — skip the fetch.
    if (code === 'en') return null;
    if (_LOCALE_JSON_CACHE[code] !== undefined) {
        return _LOCALE_JSON_CACHE[code];
    }
    // Promise placeholder prevents the double-fetch when activateLang is
    // called twice in quick succession (tests + programmatic switches).
    const p = (async () => {
        try {
            const res = await fetch(`./i18n/${code}.json`, { cache: 'default' });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data !== 'object') return null;
            // Strip `__meta__` so it can't pollute a `t('__meta__')` lookup.
            delete data.__meta__;
            return data;
        } catch (e) {
            console.warn(`[i18n] failed to load ./i18n/${code}.json:`, e);
            return null;
        }
    })();
    _LOCALE_JSON_CACHE[code] = p;
    const resolved = await p;
    // Cache the resolved value (object or null) so subsequent calls skip
    // the promise round-trip.
    _LOCALE_JSON_CACHE[code] = resolved;
    return resolved;
}


const I18N = {
    en: {
        consent_title: "Your Privacy Matters",
        consent_desc: "CRISP collects only the data needed to help rescue teams respond faster:",
        consent_loc: "Location — GPS coordinates to pinpoint the incident",
        consent_photo: "Photos — damage evidence for response teams",
        consent_audio: "Audio — voice descriptions transcribed by AI",
        consent_no_pii: "No personal identity collected",
        consent_shared: "Data shared only with crisis responders",
        consent_delete: "You can request deletion anytime",
        consent_check: "I understand and consent to sharing this data for crisis response",
        consent_accept: "Accept & Continue",
        delete_my_data: "Delete My Data", your_reports: "Your Submitted Reports", delete_all: "Delete All Reports",
        delete_confirm: "Delete this report? Your data will be permanently deleted within 24 hours. You can undo this within that time.",
        // Apr 2026 UX rewrite — landing copy simplified; old 4-card roadmap
        // removed so rs1..rs4 are dead but retained for back-compat with
        // downstream i18n consumers. New fp_* keys label the flow-progress
        // bar that replaces the step-dots on each capture stage.
        // Apr 2026 PR 3 — removed the "Tap the button when you're ready"
        // sub-copy; the big orange CTA already communicates the primary
        // action and the offline-hint at the bottom reassures users the
        // tool works in low connectivity. home_sub kept for back-compat
        // (some downstream deep-link / SMS flows may still reference it)
        // but is empty so nothing renders.
        home_title: "Report an Incident", home_sub: "",
        home_metric_reports: "Reports Submitted", home_metric_verified: "Reports Verified", home_metric_lives: "Lives Saved",
        // UNDP building-footprint selector copy (§3.2 Apr 2026).
        building_select_title: "Optional: pick the exact building",
        building_select_hint: "Tap a building outline to mark it as damaged.",
        building_selected: "Building selected",
        home_offline_hint: "📡 Works offline and in low internet connectivity.",
        fp_photo: "Photo", fp_details: "Details", fp_review: "Review", fp_send: "Send",
        my_reports: "My Reports",
        delete_all_my_reports: "Delete all my reports",
        delete_all_note: "This removes every report you've sent from this device. Your data will be permanently deleted within 24 hours.",
        in_flight: "In flight", submitted: "Submitted",
        // Apr 2026 "My Reports" spec — individual report management.
        report_detail: "Report", details_label: "Details",
        delete_this_report: "Delete this report", rejected_reason: "Not valid",
        advanced: "Advanced",
        rs1: "PHOTO", rs2: "VOICE", rs3: "CHECK", rs4: "SEND",
        start_btn: "Start Reporting",
        s1_title: "PHOTO", s1_sub: "Take picture",
        no_photo: "No photo", use_camera: "Camera", browse: "Files", photo_required: "Please capture or upload an image to continue", next: "Continue",
        pii_warning: "Avoid faces or personal documents. Faces will be auto-blurred for privacy.",
        // Apr 2026 UX rewrite (see plan at ~/.claude/plans/swirling-forging-raccoon.md):
        // audio screen speaks to low-literacy / crisis users. Bullets + example
        // remove "what should I write?" paralysis. "Tap and speak clearly" +
        // "You can speak in your language" tells users native language is OK.
        s2_title: "Tell us what happened", s2_sub: "Speak or type:",
        audio_bullet_1: "What is damaged? (house, road, people…)",
        audio_bullet_2: "How bad is it? (small / big / destroyed)",
        audio_bullet_3: "Is anyone hurt or in danger?",
        audio_example: "Example: Road is broken and water is flooding houses. 2 people are injured.",
        tap_mic: "Tap and speak clearly",
        audio_mic_lang: "You can speak in your language",
        audio_placeholder: "Example: House collapsed, one person trapped",
        transcript_hint: "Listening...",
        s3_title: "CHECK", s3_sub: "Fix text",
        photo_attached: "✅ Added", your_message: "Message:", type_your_msg: "Type...",
        what_damaged: "Damage?", road: "Road", hospital: "Clinic", house: "Home", power: "Power", water: "Water", other: "Other",
        severity_label: "Severity?", minor: "Low", moderate: "Mid", severe: "High", ready_send: "READY",
        s4_title: "SEND", s4_sub: "Tap below",
        report_id: "ID:", send_undp: "SEND", go_back: "Edit",
        // PR 7 (Apr 2026): success screen re-framed — warm close-out instead
        // of the prior bureaucratic "UNDP rescue teams have been notified".
        // `new_report` kept for back-compat with downstream deep-link flows;
        // the DOM now renders `add_another_report` but legacy consumers can
        // still resolve the old key via fallthrough.
        sent_title: "Thank you.", sent_sub: "Your report can help save lives. We will keep you posted.",
        new_report: "New Report",
        add_another_report: "Add another report",
        track_report: "Track your report",
        search_place: "Type place name...", loc_status: "Locating...",
        loc_verified: "Verified", loc_missing: "No GPS",
        loc_error: "GPS Error", loc_not_supported: "No GPS",
        retry_gps: "Tap 🔄 to retry",
        // Apr 2026 PR 1 — English authoritative values for keys that were
        // missing from EN and rendering as raw UPPERCASE_KEY names on the
        // review page (especially in non-English locales where the old
        // t() short-circuit never fell back to English). See the plan at
        // ~/.claude/plans/swirling-forging-raccoon.md for the full list.
        back: "Back",
        // Review page block labels — user-facing form sections.
        description_label: "Description",
        // PR 6 (Apr 2026): crisis label reframed as causal question.
        crisis_label: "What caused damage?",
        // PR 6: damage_label is now the inline sub-label on the merged
        // severity picker ("How bad?"). Kept as an EN key because it's still
        // referenced by data-i18n="damage_label" in the new markup.
        damage_label: "How bad?",
        infra_name_label: "Building / Road Name (optional)",
        infra_name_hint: "e.g. City Hospital, Main Street...",
        debris_label: "Needs debris clearing?",
        // PR 6: service panel summary renames to "Optional: Service status".
        service_label: "Optional: Service status",
        needs_label: "🆘 Pressing Needs",
        review_details_title: "Details",
        confirm_title: "Confirm",
        // Damage-classification enum labels (UNDP Appendix-1, 3 states).
        // UNDP spec: "Minimal/No damage", "Partially damaged", "Completely
        // damaged". `no_damage` kept as an alias so any stale index.html
        // copy in a service-worker cache continues to render sensible text.
        minimal_damage: "Minimal",
        no_damage: "Minimal",
        partial_damage: "Partial",
        complete_damage: "Destroyed",
        destroyed: "Destroyed",
        // Infrastructure-type chip labels — keep semantic parity with the
        // existing short set (road/hospital/house/power/water/other).
        school: "School",
        telecom: "Telecom",
        government: "Gov. Building",
        // UNDP super-types (exposed when the dashboard surfaces them).
        residential: "Residential",
        commercial: "Commercial",
        utility: "Utility",
        transport_communication: "Transport & Comms",
        community: "Community",
        public_spaces: "Public Spaces",
        // Crisis-type chip labels (UNDP Appendix-1).
        earthquake: "Earthquake",
        flood: "Flood",
        tsunami: "Tsunami",
        cyclone: "Cyclone",
        landslide: "Landslide",
        explosion: "Explosion",
        chemical_incident: "Chemical",
        pandemic: "Pandemic",
        conflict: "Conflict",
        civil_unrest: "Civil Unrest",
        // Legacy labels — backend still accepts HURRICANE/WILDFIRE for
        // historical rows; keep EN text for reporters who land on an
        // older cached HTML.
        hurricane: "Cyclone",
        wildfire: "Wildfire",
        other_crisis: "Other",
        // Service-status row labels (✳ emoji prefixes match existing DOM).
        electricity: "⚡ Electricity",
        water_svc: "💧 Water",
        health_svc: "🏥 Health",
        // Service-status enum labels.
        unknown: "Unknown",
        working: "Working",
        disrupted: "Disrupted",
        // Pressing-needs chip labels.
        food: "Food",
        need_water: "Water",
        shelter: "Shelter",
        medical: "Medical",
        security: "Security",
        // Apr 2026 i18n-coverage sweep — every user-visible string that
        // was previously hardcoded in index.html or app.js now has a key
        // so 100% of the UI follows the selected language. Missing keys
        // in non-English locales fall through cleanly to English via
        // the per-key t() chain (PR 1).
        // — Language picker chrome —
        lang_picker_title: "Choose language",
        lang_picker_close: "Close",
        // Apr 2026 §3.1 UX rewrite — picker is split into two sections so
        // the UNDP six-official-languages requirement is the anchor.
        lang_picker_un_section: "UN Official Languages",
        lang_picker_other_section: "Other Languages",
        // — Photo stage —
        no_photo: "No photo yet",
        // — Audio stage —
        recording_tap_stop: "Recording... Tap to Stop",
        recording_in_progress: "🎤 Recording — audio will be transcribed after submit",
        recording_done: "✅ Recording done — you can type extra details below",
        audio_recorded: "✅ Audio recorded",
        // — Upload overlay —
        upload_sending: "Sending report...",
        upload_saved: "Report saved!",
        upload_success: "Report sent!",
        upload_failed: "Upload failed — will retry",
        storage_full_toast: "⚠ Could not save report locally. Free up space on your device and try again.",
        storage_full_alert: "Could not save your report locally. Free up device storage and try again.",
        // — Sync badge —
        sync_syncing: "Syncing...",
        sync_queued: "queued",
        sync_failed: "failed",
        // — Review / confirm summary —
        summary_incident: "Incident",
        summary_details: "Details",
        summary_edit: "✏️ Edit",
        summary_debris: "🚛 Debris clearing needed",
        summary_needs_prefix: "🆘 Needs:",
        summary_none: "—",
        // — Location detection statuses —
        loc_approximate: "📍 Approximate location",
        loc_detected: "✅ Location detected",
        loc_getting: "🌐 Getting network location…",
        loc_unavailable: "⚠️ Location unavailable",
        loc_type_below: "📍 Type your location below",
        loc_resolving: "Resolving location…",
        loc_will_find: "We'll find it on the map for you",
        // — Place autocomplete —
        place_no_results: "No matches. Try a shorter or simpler name.",
        place_search_hint: "Search city or place…",
        // — Success screen already covered by sent_title / sent_sub —
        // — Delete dialogs —
        delete_requested_toast: "Deletion requested. Removed within 24 hours.",
        delete_already_removed: "Report already removed",
        delete_offline_queued: "Offline — will delete when connected",
        delete_all_confirm: "Delete ALL reports you've submitted from this device?\n\nYour data will be permanently removed within 24 hours. This cannot be undone.",
        delete_all_success: "Deletion requested. Your reports will be removed within 24 hours.",
        delete_no_reports: "No reports to delete.",
        delete_deleting: "Deleting…",
        // — In-flight / queue statuses —
        status_queued: "Queued",
        status_uploading: "Uploading",
        status_failed: "Failed",
        // — History empty states —
        empty_in_flight: "Nothing in flight. Tap Start Report to create one.",
        empty_submitted: "Nothing submitted yet.",
        // — Report detail —
        report_not_found: "Report not found",
        report_no_tracking: "No report to track yet.",
        // — Nav —
        nav_refresh: "🔄 Refresh",
        nav_back: "← Back",
        // — Take-another prompt (RN camera loop parity hint for PWA) —
        take_another_title: "Photo added ✓",
        take_another_body: "Take another?",
        take_another_yes: "Yes",
        take_another_done: "Done",
        // Apr 2026: image viewer + thumbnail-delete.
        image_delete_btn: "Delete image",
        image_delete_confirm_title: "Delete this image?",
        image_delete_confirm_body: "This image will be removed from your report.",
        image_delete_yes: "Delete",
        image_delete_cancel: "Cancel",
        image_close: "Close",
        // Apr 2026: report-detail view strings. Previously hardcoded inside
        // renderReportDetail/_mapReportStatus/_deriveActionTaken.
        rd_status_submitted: "Submitted",
        rd_status_under_review: "Under Review",
        rd_status_accepted: "Accepted",
        rd_status_rejected: "Rejected",
        rd_tl_submitted: "Submitted",
        rd_tl_review: "Under Review",
        rd_tl_accepted: "Accepted",
        rd_tl_rejected: "Rejected",
        rd_tl_help_sent: "Help Sent",
        rd_meta_location: "Location",
        rd_meta_crisis: "Crisis",
        rd_meta_what: "What",
        rd_meta_damage: "Damage",
        rd_meta_severity: "Severity",
        rd_no_details: "No additional details.",
        rd_feedback_accepted_title: "Your report helped respond quickly",
        rd_feedback_awaiting: "Accepted — awaiting dispatch",
        rd_action_help_arrived: "Help arrived on scene",
        rd_action_help_dispatched: "Help dispatched",
        rd_people_helped_one: "~1 person helped",
        rd_people_helped_many: "~{n} people helped",
        rd_rejection_default: "This report was marked not valid by reviewers.",
        rd_delete_in_progress: "Deletion in progress. This report will be permanently removed within 24 hours.",
        rd_delete_queued: "Will be deleted when connected.",
        rd_delete_confirm_prompt: "Delete this report?\n\nYour data will be permanently removed within 24 hours. This cannot be undone.",
        // Time-ago shorthand for report list cards.
        time_seconds_ago: "{n}s ago",
        time_minutes_ago: "{n} min ago",
        time_hours_ago: "{n}h ago",
        time_1_day_ago: "1 day ago",
        time_days_ago: "{n} days ago",
        time_1_month_ago: "1 month ago",
        time_months_ago: "{n} months ago"
    },
    kn: {
        consent_title: "ನಿಮ್ಮ ಗೌಪ್ಯತೆ ಮುಖ್ಯ", consent_desc: "ರಕ್ಷಣಾ ತಂಡಗಳಿಗೆ ಸಹಾಯ ಮಾಡಲು ಅಗತ್ಯ ಮಾಹಿತಿ ಮಾತ್ರ:", consent_loc: "ಸ್ಥಳ — GPS ನಿರ್ದೇಶಾಂಕಗಳು", consent_photo: "ಫೋಟೋಗಳು — ಹಾನಿ ಸಾಕ್ಷ್ಯ", consent_audio: "ಆಡಿಯೋ — ಧ್ವನಿ ವಿವರಣೆ", consent_no_pii: "ವೈಯಕ್ತಿಕ ಗುರುತು ಸಂಗ್ರಹಿಸಲಾಗುವುದಿಲ್ಲ", consent_shared: "ಬಿಕ್ಕಟ್ಟು ಪ್ರತಿಕ್ರಿಯಾಕಾರರಿಗೆ ಮಾತ್ರ", consent_delete: "ಯಾವಾಗ ಬೇಕಾದರೂ ಅಳಿಸಬಹುದು", consent_check: "ಈ ಡೇಟಾ ಹಂಚಿಕೊಳ್ಳಲು ಒಪ್ಪುತ್ತೇನೆ", consent_accept: "ಒಪ್ಪಿ ಮುಂದುವರಿಸಿ",
        delete_my_data: "ನನ್ನ ಡೇಟಾ ಅಳಿಸಿ", your_reports: "ನಿಮ್ಮ ವರದಿಗಳು", delete_all: "ಎಲ್ಲಾ ಅಳಿಸಿ",
        home_title: "ಘಟನೆಯನ್ನು ವರದಿ ಮಾಡಿ", home_sub: "ಸಿದ್ಧವಾದಾಗ ಬಟನ್ ಒತ್ತಿ.",
        home_metric_reports: "ವರದಿಗಳು ಸಲ್ಲಿಸಲಾಗಿದೆ", home_metric_verified: "ಪರಿಶೀಲಿಸಿದ ವರದಿಗಳು", home_metric_lives: "ಉಳಿಸಿದ ಜೀವಗಳು",
        home_offline_hint: "📡 ಆಫ್‌ಲೈನ್ ಮತ್ತು ಕಡಿಮೆ ಇಂಟರ್ನೆಟ್ ಸಂಪರ್ಕದಲ್ಲಿ ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತದೆ.",
        fp_photo: "ಫೋಟೋ", fp_details: "ವಿವರ", fp_review: "ಪರಿಶೀಲನೆ", fp_send: "ಕಳುಹಿಸಿ",
        my_reports: "ನನ್ನ ವರದಿಗಳು",
        delete_all_my_reports: "ನನ್ನ ಎಲ್ಲಾ ವರದಿಗಳನ್ನು ಅಳಿಸಿ",
        delete_all_note: "ಈ ಸಾಧನದಿಂದ ನೀವು ಕಳುಹಿಸಿದ ಎಲ್ಲಾ ವರದಿಗಳನ್ನು ತೆಗೆಯುತ್ತದೆ. ನಿಮ್ಮ ಡೇಟಾ 24 ಗಂಟೆಗಳಲ್ಲಿ ಶಾಶ್ವತವಾಗಿ ಅಳಿಸಲ್ಪಡುತ್ತದೆ.",
        in_flight: "ಹಾರಾಟದಲ್ಲಿ", submitted: "ಸಲ್ಲಿಸಲಾಗಿದೆ",
        rs1: "ಫೋಟೋ", rs2: "ಧ್ವನಿ", rs3: "ಪರಿಶೀಲಿಸಿ", rs4: "ಕಳುಹಿಸಿ",
        start_btn: "ವರದಿ ಪ್ರಾರಂಭಿಸಿ",
        s1_title: "ಫೋಟೋ", s1_sub: "ಚಿತ್ರ ತೆಗೆಯಿರಿ",
        no_photo: "ಹಾಕಿ", use_camera: "ಕ್ಯಾಮೆರಾ", browse: "ಹುಡುಕಿ", skip_photo: "ಬಿಟ್ಟುಬಿಡಿ", next: "ಮುಂದುವರಿಸಿ",
        // Apr 2026 UX rewrite — low-literacy-friendly copy (see en block above).
        s2_title: "ಏನಾಯಿತು ಎಂದು ಹೇಳಿ", s2_sub: "ಮಾತನಾಡಿ ಅಥವಾ ಟೈಪ್ ಮಾಡಿ:",
        audio_bullet_1: "ಏನು ಹಾನಿಯಾಗಿದೆ? (ಮನೆ, ರಸ್ತೆ, ಜನರು…)",
        audio_bullet_2: "ಎಷ್ಟು ಹಾನಿ? (ಸಣ್ಣ / ದೊಡ್ಡ / ಸಂಪೂರ್ಣ ಹಾನಿ)",
        audio_bullet_3: "ಯಾರಾದರೂ ಗಾಯಗೊಂಡಿದ್ದಾರೆಯೇ ಅಥವಾ ಅಪಾಯದಲ್ಲಿದ್ದಾರೆಯೇ?",
        audio_example: "ಉದಾಹರಣೆ: ರಸ್ತೆ ಮುರಿದಿದೆ ಮತ್ತು ನೀರು ಮನೆಗಳಿಗೆ ಹರಿಯುತ್ತಿದೆ. 2 ಜನರಿಗೆ ಗಾಯವಾಗಿದೆ.",
        tap_mic: "ಸ್ಪಷ್ಟವಾಗಿ ಮಾತನಾಡಲು ಒತ್ತಿ",
        audio_mic_lang: "ನೀವು ನಿಮ್ಮ ಭಾಷೆಯಲ್ಲಿ ಮಾತನಾಡಬಹುದು",
        audio_placeholder: "ಉದಾಹರಣೆ: ಮನೆ ಕುಸಿದಿದೆ, ಒಬ್ಬ ವ್ಯಕ್ತಿ ಸಿಲುಕಿಕೊಂಡಿದ್ದಾರೆ",
        transcript_hint: "ಕೇಳುತ್ತಿದ್ದೇವೆ...",
        s3_title: "ಪರಿಶೀಲಿಸಿ", s3_sub: "ತಿದ್ದಿ",
        photo_attached: "✅ ಸೇರಿಸಲಾಗಿದೆ", your_message: "ಸಂದೇಶ:", type_your_msg: "ಟೈಪ್ ಮಾಡಿ...",
        what_damaged: "ಹಾನಿ?", road: "ರಸ್ತೆ", hospital: "ಆಸ್ಪತ್ರೆ", house: "ಮನೆ", power: "ವಿದ್ಯುತ್", water: "ನೀರು", other: "ಇತರ",
        severity_label: "ಗಂಭೀರತೆ?", minor: "ಕಡಿಮೆ", moderate: "ಮಧ್ಯಮ", severe: "ಹೆಚ್ಚು", ready_send: "ಸಿದ್ಧ",
        s4_title: "ಕಳುಹಿಸಿ", s4_sub: "ಒತ್ತಿ",
        report_id: "ID:", send_undp: "ಕಳುಹಿಸಿ", go_back: "ತಿದ್ದಿ",
        sent_title: "ಕಳುಹಿಸಲಾಗಿದೆ!", sent_sub: "ಸಹಾಯ ಬರಲಿದೆ.\nಧನ್ಯವಾದ.",
        new_report: "ಹೊಸ",
        search_place: "ಸ್ಥಳದ ಹೆಸರು...", loc_status: "ಹುಡುಕುತ್ತಿದ್ದೇವೆ...",
        loc_verified: "ಪರಿಶೀಲಿಸಲಾಗಿದೆ", loc_missing: "GPS ಇಲ್ಲ",
        loc_error: "GPS ದೋಷ", loc_not_supported: "GPS ಇಲ್ಲ",
        retry_gps: "Tap 🔄 ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಲು",
        // Apr 2026 i18n-coverage sweep — Kannada translations for the
        // full set of previously-hardcoded strings. Missing keys fall
        // through to English via the per-key t() chain (PR 1).
        lang_picker_title: "ಭಾಷೆಯನ್ನು ಆರಿಸಿ",
        lang_picker_close: "ಮುಚ್ಚಿ",
        no_photo: "ಇನ್ನೂ ಫೋಟೋ ಇಲ್ಲ",
        recording_tap_stop: "ರೆಕಾರ್ಡ್ ಆಗುತ್ತಿದೆ... ನಿಲ್ಲಿಸಲು ಒತ್ತಿ",
        recording_in_progress: "🎤 ರೆಕಾರ್ಡ್ ಆಗುತ್ತಿದೆ — ಸಲ್ಲಿಸಿದ ನಂತರ ಲಿಪ್ಯಂತರಣವಾಗುತ್ತದೆ",
        recording_done: "✅ ರೆಕಾರ್ಡಿಂಗ್ ಮುಗಿದಿದೆ — ಕೆಳಗೆ ಹೆಚ್ಚಿನ ವಿವರಗಳನ್ನು ಟೈಪ್ ಮಾಡಬಹುದು",
        audio_recorded: "✅ ಆಡಿಯೋ ರೆಕಾರ್ಡ್ ಆಗಿದೆ",
        upload_sending: "ವರದಿ ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ...",
        upload_saved: "ವರದಿ ಉಳಿಸಲಾಗಿದೆ!",
        upload_success: "ವರದಿ ಕಳುಹಿಸಲಾಗಿದೆ!",
        upload_failed: "ಅಪ್‌ಲೋಡ್ ವಿಫಲ — ಮರುಪ್ರಯತ್ನಿಸಲಾಗುತ್ತದೆ",
        storage_full_toast: "⚠ ಸ್ಥಳೀಯವಾಗಿ ಉಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಜಾಗ ಮುಕ್ತಗೊಳಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
        storage_full_alert: "ವರದಿಯನ್ನು ಸ್ಥಳೀಯವಾಗಿ ಉಳಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಸಾಧನದ ಸಂಗ್ರಹಣೆಯನ್ನು ಮುಕ್ತಗೊಳಿಸಿ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
        sync_syncing: "ಸಿಂಕ್ ಮಾಡಲಾಗುತ್ತಿದೆ...",
        sync_queued: "ಸರದಿಯಲ್ಲಿ",
        sync_failed: "ವಿಫಲ",
        summary_incident: "ಘಟನೆ",
        summary_details: "ವಿವರಗಳು",
        summary_edit: "✏️ ಸಂಪಾದಿಸಿ",
        summary_debris: "🚛 ಅವಶೇಷ ತೆರವು ಅಗತ್ಯ",
        summary_needs_prefix: "🆘 ಅಗತ್ಯಗಳು:",
        summary_none: "—",
        loc_approximate: "📍 ಅಂದಾಜು ಸ್ಥಳ",
        loc_detected: "✅ ಸ್ಥಳ ಪತ್ತೆಯಾಗಿದೆ",
        loc_getting: "🌐 ನೆಟ್‌ವರ್ಕ್ ಸ್ಥಳ ಪಡೆಯಲಾಗುತ್ತಿದೆ…",
        loc_unavailable: "⚠️ ಸ್ಥಳ ಲಭ್ಯವಿಲ್ಲ",
        loc_type_below: "📍 ಕೆಳಗೆ ನಿಮ್ಮ ಸ್ಥಳವನ್ನು ಟೈಪ್ ಮಾಡಿ",
        loc_resolving: "ಸ್ಥಳವನ್ನು ಪರಿಹರಿಸಲಾಗುತ್ತಿದೆ…",
        loc_will_find: "ನಕ್ಷೆಯಲ್ಲಿ ನಾವು ಅದನ್ನು ಹುಡುಕುತ್ತೇವೆ",
        place_no_results: "ಯಾವುದೇ ಹೊಂದಾಣಿಕೆ ಇಲ್ಲ. ಚಿಕ್ಕ ಅಥವಾ ಸರಳ ಹೆಸರನ್ನು ಪ್ರಯತ್ನಿಸಿ.",
        place_search_hint: "ನಗರ ಅಥವಾ ಸ್ಥಳವನ್ನು ಹುಡುಕಿ…",
        delete_requested_toast: "ಅಳಿಸುವ ವಿನಂತಿ. 24 ಗಂಟೆಗಳೊಳಗೆ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ.",
        delete_already_removed: "ವರದಿ ಈಗಾಗಲೇ ತೆಗೆದುಹಾಕಲಾಗಿದೆ",
        delete_offline_queued: "ಆಫ್‌ಲೈನ್ — ಸಂಪರ್ಕಿಸಿದಾಗ ಅಳಿಸಲಾಗುವುದು",
        delete_all_confirm: "ಈ ಸಾಧನದಿಂದ ಸಲ್ಲಿಸಿದ ಎಲ್ಲಾ ವರದಿಗಳನ್ನು ಅಳಿಸಬೇಕೆ?\n\nನಿಮ್ಮ ಡೇಟಾವನ್ನು 24 ಗಂಟೆಗಳೊಳಗೆ ಶಾಶ್ವತವಾಗಿ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ. ಇದನ್ನು ರದ್ದುಗೊಳಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ.",
        delete_all_success: "ಅಳಿಸುವ ವಿನಂತಿ. ನಿಮ್ಮ ವರದಿಗಳನ್ನು 24 ಗಂಟೆಗಳೊಳಗೆ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ.",
        delete_no_reports: "ಅಳಿಸಲು ವರದಿಗಳಿಲ್ಲ.",
        delete_deleting: "ಅಳಿಸಲಾಗುತ್ತಿದೆ…",
        status_queued: "ಸರದಿಯಲ್ಲಿ",
        status_uploading: "ಅಪ್‌ಲೋಡ್ ಆಗುತ್ತಿದೆ",
        status_failed: "ವಿಫಲ",
        empty_in_flight: "ಹಾರಾಟದಲ್ಲಿ ಏನೂ ಇಲ್ಲ. ಹೊಸದನ್ನು ರಚಿಸಲು ವರದಿ ಪ್ರಾರಂಭಿಸಿ ಒತ್ತಿ.",
        empty_submitted: "ಇನ್ನೂ ಏನೂ ಸಲ್ಲಿಸಿಲ್ಲ.",
        report_not_found: "ವರದಿ ಸಿಗಲಿಲ್ಲ",
        report_no_tracking: "ಇನ್ನೂ ಟ್ರ್ಯಾಕ್ ಮಾಡಲು ವರದಿ ಇಲ್ಲ.",
        nav_refresh: "🔄 ರಿಫ್ರೆಶ್",
        nav_back: "← ಹಿಂದೆ",
        take_another_title: "ಫೋಟೋ ಸೇರಿಸಲಾಗಿದೆ ✓",
        take_another_body: "ಇನ್ನೊಂದು ತೆಗೆಯಬೇಕೆ?",
        take_another_yes: "ಹೌದು",
        take_another_done: "ಮುಗಿಸಿ",
        image_delete_btn: "ಚಿತ್ರ ಅಳಿಸಿ",
        image_delete_confirm_title: "ಈ ಚಿತ್ರವನ್ನು ಅಳಿಸಬೇಕೆ?",
        image_delete_confirm_body: "ಈ ಚಿತ್ರವನ್ನು ನಿಮ್ಮ ವರದಿಯಿಂದ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ.",
        image_delete_yes: "ಅಳಿಸಿ",
        image_delete_cancel: "ರದ್ದುಗೊಳಿಸಿ",
        image_close: "ಮುಚ್ಚಿ",
        review_details_title: "ವಿವರಗಳು",
        confirm_title: "ದೃಢೀಕರಿಸಿ",
        rd_status_submitted: "ಸಲ್ಲಿಸಲಾಗಿದೆ",
        rd_status_under_review: "ಪರಿಶೀಲನೆಯಲ್ಲಿ",
        rd_status_accepted: "ಅಂಗೀಕರಿಸಲಾಗಿದೆ",
        rd_status_rejected: "ತಿರಸ್ಕರಿಸಲಾಗಿದೆ",
        rd_tl_submitted: "ಸಲ್ಲಿಸಲಾಗಿದೆ",
        rd_tl_review: "ಪರಿಶೀಲನೆಯಲ್ಲಿ",
        rd_tl_accepted: "ಅಂಗೀಕರಿಸಲಾಗಿದೆ",
        rd_tl_rejected: "ತಿರಸ್ಕರಿಸಲಾಗಿದೆ",
        rd_tl_help_sent: "ಸಹಾಯ ಕಳುಹಿಸಲಾಗಿದೆ",
        rd_meta_location: "ಸ್ಥಳ",
        rd_meta_crisis: "ಬಿಕ್ಕಟ್ಟು",
        rd_meta_what: "ಏನು",
        rd_meta_damage: "ಹಾನಿ",
        rd_meta_severity: "ಗಂಭೀರತೆ",
        rd_no_details: "ಹೆಚ್ಚಿನ ವಿವರಗಳಿಲ್ಲ.",
        rd_feedback_accepted_title: "ನಿಮ್ಮ ವರದಿಯು ತ್ವರಿತ ಪ್ರತಿಕ್ರಿಯೆಗೆ ಸಹಾಯ ಮಾಡಿತು",
        rd_feedback_awaiting: "ಸ್ವೀಕರಿಸಲಾಗಿದೆ — ರವಾನಿಸಲು ಕಾಯುತ್ತಿದೆ",
        rd_action_help_arrived: "ಸ್ಥಳಕ್ಕೆ ಸಹಾಯ ಬಂದಿದೆ",
        rd_action_help_dispatched: "ಸಹಾಯ ರವಾನಿಸಲಾಗಿದೆ",
        rd_people_helped_one: "~1 ವ್ಯಕ್ತಿಗೆ ಸಹಾಯ",
        rd_people_helped_many: "~{n} ಜನರಿಗೆ ಸಹಾಯ",
        rd_rejection_default: "ಈ ವರದಿಯನ್ನು ಪರಿಶೀಲಕರು ಅಮಾನ್ಯವೆಂದು ಗುರುತಿಸಿದ್ದಾರೆ.",
        rd_delete_in_progress: "ಅಳಿಸುವಿಕೆ ಪ್ರಗತಿಯಲ್ಲಿದೆ. ಈ ವರದಿಯನ್ನು 24 ಗಂಟೆಗಳೊಳಗೆ ಶಾಶ್ವತವಾಗಿ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ.",
        rd_delete_queued: "ಸಂಪರ್ಕಿಸಿದಾಗ ಅಳಿಸಲಾಗುವುದು.",
        rd_delete_confirm_prompt: "ಈ ವರದಿಯನ್ನು ಅಳಿಸಬೇಕೆ?\n\nನಿಮ್ಮ ಡೇಟಾವನ್ನು 24 ಗಂಟೆಗಳೊಳಗೆ ಶಾಶ್ವತವಾಗಿ ತೆಗೆದುಹಾಕಲಾಗುತ್ತದೆ. ಇದನ್ನು ರದ್ದುಗೊಳಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ.",
        time_seconds_ago: "{n} ಸೆಕೆಂಡುಗಳ ಹಿಂದೆ",
        time_minutes_ago: "{n} ನಿಮಿಷಗಳ ಹಿಂದೆ",
        time_hours_ago: "{n} ಗಂಟೆಗಳ ಹಿಂದೆ",
        time_1_day_ago: "1 ದಿನದ ಹಿಂದೆ",
        time_days_ago: "{n} ದಿನಗಳ ಹಿಂದೆ",
        time_1_month_ago: "1 ತಿಂಗಳ ಹಿಂದೆ",
        time_months_ago: "{n} ತಿಂಗಳ ಹಿಂದೆ"
    },
    hi: {
        consent_title: "आपकी गोपनीयता महत्वपूर्ण है", consent_desc: "बचाव दलों की मदद के लिए केवल आवश्यक डेटा:", consent_loc: "स्थान — GPS निर्देशांक", consent_photo: "फोटो — क्षति का प्रमाण", consent_audio: "ऑडियो — आवाज विवरण", consent_no_pii: "कोई व्यक्तिगत पहचान नहीं", consent_shared: "केवल आपदा प्रतिक्रियाकर्ताओं के लिए", consent_delete: "कभी भी हटा सकते हैं", consent_check: "मैं इस डेटा को साझा करने के लिए सहमत हूँ", consent_accept: "स्वीकार करें",
        delete_my_data: "मेरा डेटा हटाएं", your_reports: "आपकी रिपोर्टें", delete_all: "सभी हटाएं",
        home_title: "घटना की रिपोर्ट करें", home_sub: "तैयार होने पर बटन दबाएं।",
        home_metric_reports: "कुल रिपोर्टें", home_metric_verified: "सत्यापित रिपोर्टें", home_metric_lives: "बचाई गई जानें",
        home_offline_hint: "📡 ऑफ़लाइन और कम इंटरनेट कनेक्टिविटी में काम करता है।",
        fp_photo: "फोटो", fp_details: "विवरण", fp_review: "जांचें", fp_send: "भेजें",
        my_reports: "मेरी रिपोर्टें",
        delete_all_my_reports: "मेरी सभी रिपोर्टें हटाएं",
        delete_all_note: "इस डिवाइस से भेजी गई सभी रिपोर्टें हटेंगी। आपका डेटा 24 घंटे में स्थायी रूप से हट जाएगा।",
        in_flight: "भेजा जा रहा है", submitted: "भेजी गई",
        rs1: "फोटो", rs2: "आवाज़", rs3: "जांचें", rs4: "भेजें",
        start_btn: "रिपोर्ट शुरू करें",
        s1_title: "फोटो", s1_sub: "चित्र लें",
        no_photo: "नहीं है", use_camera: "कैमरा", browse: "फाइल", skip_photo: "छोड़ें", next: "आगे बढ़ें",
        pii_warning: "चेहरे या व्यक्तिगत दस्तावेज न दिखाएं। चेहरे गोपनीयता के लिए स्वचालित रूप से धुंधले होंगे।",
        // Apr 2026 UX rewrite — low-literacy-friendly copy.
        s2_title: "हमें बताएं क्या हुआ", s2_sub: "बोलें या टाइप करें:",
        audio_bullet_1: "क्या नुकसान हुआ है? (घर, सड़क, लोग…)",
        audio_bullet_2: "कितना बुरा है? (छोटा / बड़ा / पूरी तरह नष्ट)",
        audio_bullet_3: "क्या कोई घायल है या खतरे में है?",
        audio_example: "उदाहरण: सड़क टूट गई है और पानी घरों में घुस रहा है। 2 लोग घायल हैं।",
        tap_mic: "साफ़ बोलने के लिए दबाएं",
        audio_mic_lang: "आप अपनी भाषा में बोल सकते हैं",
        audio_placeholder: "उदाहरण: घर गिर गया, एक व्यक्ति फंसा है",
        transcript_hint: "सुन रहे हैं...",
        s3_title: "जांचें", s3_sub: "सुधारें",
        photo_attached: "✅ जोड़ा गया", your_message: "संदेश:", type_your_msg: "टाइप करें...",
        what_damaged: "क्षति?", road: "सड़क", hospital: "क्लीनिक", house: "घर", power: "बिजली", water: "पानी", other: "अन्य",
        severity_label: "गंभीरता?", minor: "कम", moderate: "मध्यम", severe: "उच्च", ready_send: "तैयार",
        s4_title: "भेजें", s4_sub: "दबाएं",
        report_id: "ID:", send_undp: "भेजें", go_back: "बदलें",
        sent_title: "भेज दिया!", sent_sub: "मदद आ रही है।\nधन्यवाद।",
        new_report: "नया",
        search_place: "जगह का नाम...", loc_status: "ढूँढ रहे हैं...",
        loc_verified: "सत्यापित", loc_missing: "GPS नहीं",
        loc_error: "GPS त्रुटि", loc_not_supported: "GPS नहीं",
        retry_gps: "Tap 🔄 फिर से",
        // Apr 2026 i18n-coverage sweep — Hindi translations.
        lang_picker_title: "भाषा चुनें",
        lang_picker_close: "बंद करें",
        no_photo: "अभी तक कोई फोटो नहीं",
        recording_tap_stop: "रिकॉर्ड हो रहा है... रोकने के लिए टैप करें",
        recording_in_progress: "🎤 रिकॉर्ड हो रहा है — भेजने के बाद ऑडियो लिखा जाएगा",
        recording_done: "✅ रिकॉर्डिंग पूरी — नीचे अतिरिक्त विवरण लिख सकते हैं",
        audio_recorded: "✅ ऑडियो रिकॉर्ड हो गया",
        upload_sending: "रिपोर्ट भेजी जा रही है...",
        upload_saved: "रिपोर्ट सहेजी गई!",
        upload_success: "रिपोर्ट भेज दी!",
        upload_failed: "अपलोड विफल — फिर कोशिश की जाएगी",
        storage_full_toast: "⚠ स्थानीय रूप से सहेज नहीं सका। डिवाइस पर जगह खाली करें।",
        storage_full_alert: "रिपोर्ट स्थानीय रूप से सहेजी नहीं जा सकी। डिवाइस संग्रह खाली करें।",
        sync_syncing: "सिंक हो रहा है...",
        sync_queued: "कतार में",
        sync_failed: "विफल",
        summary_incident: "घटना",
        summary_details: "विवरण",
        summary_edit: "✏️ संपादित करें",
        summary_debris: "🚛 मलबा हटाने की जरूरत",
        summary_needs_prefix: "🆘 जरूरतें:",
        summary_none: "—",
        loc_approximate: "📍 अनुमानित स्थान",
        loc_detected: "✅ स्थान पता लग गया",
        loc_getting: "🌐 नेटवर्क स्थान प्राप्त किया जा रहा है…",
        loc_unavailable: "⚠️ स्थान उपलब्ध नहीं",
        loc_type_below: "📍 नीचे अपना स्थान लिखें",
        loc_resolving: "स्थान हल किया जा रहा है…",
        loc_will_find: "हम इसे मानचित्र पर खोज लेंगे",
        place_no_results: "कोई मेल नहीं मिला। छोटा या सरल नाम आज़माएँ।",
        place_search_hint: "शहर या स्थान खोजें…",
        delete_requested_toast: "हटाने का अनुरोध। 24 घंटे के भीतर हटा दिया जाएगा।",
        delete_already_removed: "रिपोर्ट पहले ही हटा दी गई",
        delete_offline_queued: "ऑफ़लाइन — कनेक्ट होने पर हटेगी",
        delete_all_confirm: "इस डिवाइस से भेजी गई सभी रिपोर्टें हटाएँ?\n\nआपका डेटा 24 घंटे के भीतर स्थायी रूप से हटा दिया जाएगा। यह पूर्ववत नहीं किया जा सकता।",
        delete_all_success: "हटाने का अनुरोध। आपकी रिपोर्टें 24 घंटे के भीतर हटा दी जाएँगी।",
        delete_no_reports: "हटाने के लिए कोई रिपोर्ट नहीं।",
        delete_deleting: "हटाया जा रहा है…",
        status_queued: "कतार में",
        status_uploading: "अपलोड हो रहा है",
        status_failed: "विफल",
        empty_in_flight: "कोई रिपोर्ट उड़ान पर नहीं। नई बनाने के लिए रिपोर्ट शुरू टैप करें।",
        empty_submitted: "अभी तक कुछ नहीं भेजा।",
        report_not_found: "रिपोर्ट नहीं मिली",
        report_no_tracking: "अभी ट्रैक करने के लिए कोई रिपोर्ट नहीं।",
        nav_refresh: "🔄 ताज़ा करें",
        nav_back: "← पीछे",
        take_another_title: "फोटो जोड़ी गई ✓",
        take_another_body: "एक और लेना चाहेंगे?",
        take_another_yes: "हाँ",
        take_another_done: "हो गया",
        image_delete_btn: "छवि हटाएँ",
        image_delete_confirm_title: "यह छवि हटाएँ?",
        image_delete_confirm_body: "यह छवि आपकी रिपोर्ट से हटा दी जाएगी।",
        image_delete_yes: "हटाएँ",
        image_delete_cancel: "रद्द",
        image_close: "बंद करें",
        review_details_title: "विवरण",
        confirm_title: "पुष्टि करें",
        rd_status_submitted: "भेजी गई",
        rd_status_under_review: "समीक्षा में",
        rd_status_accepted: "स्वीकृत",
        rd_status_rejected: "अस्वीकृत",
        rd_tl_submitted: "भेजी गई",
        rd_tl_review: "समीक्षा में",
        rd_tl_accepted: "स्वीकृत",
        rd_tl_rejected: "अस्वीकृत",
        rd_tl_help_sent: "सहायता भेजी गई",
        rd_meta_location: "स्थान",
        rd_meta_crisis: "आपदा",
        rd_meta_what: "क्या",
        rd_meta_damage: "क्षति",
        rd_meta_severity: "गंभीरता",
        rd_no_details: "कोई अतिरिक्त विवरण नहीं।",
        rd_feedback_accepted_title: "आपकी रिपोर्ट ने त्वरित प्रतिक्रिया में मदद की",
        rd_feedback_awaiting: "स्वीकृत — प्रेषण की प्रतीक्षा में",
        rd_action_help_arrived: "स्थल पर सहायता पहुँची",
        rd_action_help_dispatched: "सहायता भेजी गई",
        rd_people_helped_one: "~1 व्यक्ति की मदद",
        rd_people_helped_many: "~{n} लोगों की मदद",
        rd_rejection_default: "इस रिपोर्ट को समीक्षकों ने अमान्य चिह्नित किया।",
        rd_delete_in_progress: "हटाने की प्रक्रिया जारी है। यह रिपोर्ट 24 घंटे में स्थायी रूप से हटा दी जाएगी।",
        rd_delete_queued: "कनेक्ट होने पर हटा दी जाएगी।",
        rd_delete_confirm_prompt: "यह रिपोर्ट हटाएँ?\n\nआपका डेटा 24 घंटे में स्थायी रूप से हटा दिया जाएगा। यह वापस नहीं लिया जा सकता।",
        time_seconds_ago: "{n} सेकंड पहले",
        time_minutes_ago: "{n} मिनट पहले",
        time_hours_ago: "{n} घंटे पहले",
        time_1_day_ago: "1 दिन पहले",
        time_days_ago: "{n} दिन पहले",
        time_1_month_ago: "1 महीना पहले",
        time_months_ago: "{n} महीने पहले"
    },
    ta: {
        consent_title: "உங்கள் தனியுரிமை முக்கியம்", consent_desc: "மீட்புக் குழுக்களுக்கு உதவ தேவையான தகவல் மட்டும்:", consent_loc: "இடம் — GPS ஆயங்கள்", consent_photo: "புகைப்படங்கள் — சேத ஆதாரம்", consent_audio: "ஆடியோ — குரல் விளக்கம்", consent_no_pii: "தனிப்பட்ட அடையாளம் சேகரிக்கப்படாது", consent_shared: "நெருக்கடி மீட்பாளர்களுக்கு மட்டும்", consent_delete: "எப்போது வேண்டுமானாலும் நீக்கலாம்", consent_check: "இந்தத் தகவலைப் பகிர ஒப்புக்கொள்கிறேன்", consent_accept: "ஏற்கவும்",
        delete_my_data: "என் தரவை நீக்கு", your_reports: "உங்கள் அறிக்கைகள்", delete_all: "அனைத்தும் நீக்கு",
        // Landing / home chrome.
        home_title: "நிகழ்வை புகாரளிக்கவும்", home_sub: "",
        home_metric_reports: "சமர்ப்பிக்கப்பட்ட அறிக்கைகள்",
        home_metric_verified: "சரிபார்க்கப்பட்ட அறிக்கைகள்",
        home_metric_lives: "காப்பாற்றப்பட்ட உயிர்கள்",
        home_offline_hint: "📡 ஆஃப்லைனிலும் குறைந்த இணைய இணைப்பிலும் செயல்படுகிறது.",
        fp_photo: "புகைப்படம்", fp_details: "விவரங்கள்", fp_review: "மதிப்பாய்வு", fp_send: "அனுப்பு",
        my_reports: "எனது அறிக்கைகள்",
        start_btn: "அறிக்கை தொடங்கு",
        // Apr 2026 UX rewrite — low-literacy-friendly copy.
        next: "தொடரவும்",
        s2_title: "என்ன நடந்தது என்று சொல்லுங்கள்", s2_sub: "பேசவும் அல்லது தட்டச்சு செய்யவும்:",
        audio_bullet_1: "என்ன சேதமடைந்துள்ளது? (வீடு, சாலை, மக்கள்…)",
        audio_bullet_2: "எவ்வளவு மோசம்? (சிறிய / பெரிய / முற்றிலும் அழிந்தது)",
        audio_bullet_3: "யாரேனும் காயமடைந்துள்ளாரா அல்லது ஆபத்தில் உள்ளாரா?",
        audio_example: "உதாரணம்: சாலை உடைந்துள்ளது, வீடுகளில் தண்ணீர் புகுகிறது. 2 பேர் காயமடைந்துள்ளனர்.",
        tap_mic: "தெளிவாக பேச அழுத்தவும்",
        audio_mic_lang: "நீங்கள் உங்கள் மொழியில் பேசலாம்",
        audio_placeholder: "உதாரணம்: வீடு இடிந்துவிட்டது, ஒருவர் சிக்கியுள்ளார்",
        transcript_hint: "கேட்கிறோம்...",
        s3_title: "உங்கள் செய்தியை சரிபார்க்கவும்", s3_sub: "தவறு இருந்தால் திருத்தவும் — அல்லது தொடரவும்",
        photo_attached: "✅ புகைப்படம் இணைக்கப்பட்டது", your_message: "உங்கள் செய்தி:", type_your_msg: "என்ன நடந்தது...",
        what_damaged: "என்ன சேதமடைந்தது?", road: "சாலை", hospital: "மருத்துவமனை", house: "வீடு", power: "மின்சாரம்", water: "நீர்", other: "மற்றவை",
        severity_label: "எவ்வளவு தீவிரம்?", minor: "சிறிய", moderate: "மிதமான", severe: "தீவிர", ready_send: "அனுப்பத் தயார்",
        s4_title: "UNDP க்கு அனுப்பவும்", s4_sub: "உங்கள் அறிக்கை தயார். அனுப்ப அழுத்தவும்.",
        report_id: "அறிக்கை ID:", send_undp: "UNDP க்கு அனுப்பவும்", go_back: "அறிக்கை திருத்தவும்",
        sent_title: "அறிக்கை அனுப்பப்பட்டது!", sent_sub: "UNDP மீட்புக் குழுக்களுக்கு தெரிவிக்கப்பட்டது.\nமிக்க நன்றி.",
        new_report: "புதிய அறிக்கை",
        search_place: "அல்லது இடத்தின் பெயரை தட்டச்சு செய்க...", loc_status: "கண்டறியப்படுகிறது...",
        loc_verified: "இடம் சரிபார்க்கப்பட்டது", loc_missing: "இடம் இல்லை",
        loc_error: "ஜிபிஎஸ் பிழை", loc_not_supported: "ஜிபிಎಸ್ ஆதரிக்கப்படவில்லை",
        retry_gps: "மீண்டும் முயற்சிக்க புதுப்பிக்கவும்",
        // Apr 2026 i18n-coverage sweep — Tamil translations.
        lang_picker_title: "மொழியைத் தேர்ந்தெடுக்கவும்",
        lang_picker_close: "மூடு",
        no_photo: "இன்னும் புகைப்படம் இல்லை",
        recording_tap_stop: "பதிவு செய்யப்படுகிறது... நிறுத்த தட்டவும்",
        recording_in_progress: "🎤 பதிவு செய்யப்படுகிறது — சமர்ப்பித்த பிறகு எழுதப்படும்",
        recording_done: "✅ பதிவு முடிந்தது — கீழே கூடுதல் விவரங்களை தட்டச்சு செய்யலாம்",
        audio_recorded: "✅ ஆடியோ பதிவு செய்யப்பட்டது",
        upload_sending: "அறிக்கை அனுப்பப்படுகிறது...",
        upload_saved: "அறிக்கை சேமிக்கப்பட்டது!",
        upload_success: "அறிக்கை அனுப்பப்பட்டது!",
        upload_failed: "பதிவேற்றம் தோல்வி — மீண்டும் முயற்சிக்கப்படும்",
        storage_full_toast: "⚠ உள்ளூரில் சேமிக்க முடியவில்லை. சாதனத்தில் இடத்தை விடுங்கள்.",
        storage_full_alert: "அறிக்கையை உள்ளூரில் சேமிக்க முடியவில்லை. சாதன சேமிப்பகத்தை விடுங்கள்.",
        sync_syncing: "ஒத்திசைக்கப்படுகிறது...",
        sync_queued: "வரிசையில்",
        sync_failed: "தோல்வி",
        summary_incident: "சம்பவம்",
        summary_details: "விவரங்கள்",
        summary_edit: "✏️ திருத்து",
        summary_debris: "🚛 குப்பை அகற்றம் தேவை",
        summary_needs_prefix: "🆘 தேவைகள்:",
        summary_none: "—",
        loc_approximate: "📍 தோராயமான இடம்",
        loc_detected: "✅ இடம் கண்டறியப்பட்டது",
        loc_getting: "🌐 நெட்வொர்க் இடம் பெறப்படுகிறது…",
        loc_unavailable: "⚠️ இடம் கிடைக்கவில்லை",
        loc_type_below: "📍 கீழே உங்கள் இடத்தை தட்டச்சு செய்யவும்",
        loc_resolving: "இடம் தீர்க்கப்படுகிறது…",
        loc_will_find: "வரைபடத்தில் நாங்கள் அதை கண்டுபிடிப்போம்",
        place_no_results: "பொருத்தம் இல்லை. குறுகிய அல்லது எளிய பெயரை முயற்சிக்கவும்.",
        place_search_hint: "நகரம் அல்லது இடத்தை தேடவும்…",
        delete_requested_toast: "நீக்க கோரிக்கை. 24 மணி நேரத்திற்குள் நீக்கப்படும்.",
        delete_already_removed: "அறிக்கை ஏற்கனவே நீக்கப்பட்டது",
        delete_offline_queued: "ஆஃப்லைன் — இணைக்கப்பட்டவுடன் நீக்கப்படும்",
        delete_all_confirm: "இந்த சாதனத்தில் இருந்து சமர்ப்பிக்கப்பட்ட அனைத்து அறிக்கைகளையும் நீக்கவா?\n\nஉங்கள் தரவு 24 மணி நேரத்திற்குள் நிரந்தரமாக நீக்கப்படும். இதை மாற்ற முடியாது.",
        delete_all_success: "நீக்க கோரிக்கை. உங்கள் அறிக்கைகள் 24 மணி நேரத்திற்குள் நீக்கப்படும்.",
        delete_no_reports: "நீக்க அறிக்கைகள் எதுவும் இல்லை.",
        delete_deleting: "நீக்கப்படுகிறது…",
        status_queued: "வரிசையில்",
        status_uploading: "பதிவேற்றப்படுகிறது",
        status_failed: "தோல்வி",
        empty_in_flight: "பறக்கும் நிலையில் எதுவும் இல்லை. புதியதை உருவாக்க அறிக்கை தொடங்கு என்பதை தட்டவும்.",
        empty_submitted: "இன்னும் எதுவும் சமர்ப்பிக்கப்படவில்லை.",
        report_not_found: "அறிக்கை கிடைக்கவில்லை",
        report_no_tracking: "கண்காணிக்க இன்னும் அறிக்கை இல்லை.",
        nav_refresh: "🔄 புதுப்பி",
        nav_back: "← பின்",
        take_another_title: "புகைப்படம் சேர்க்கப்பட்டது ✓",
        take_another_body: "மற்றொன்று எடுக்கவா?",
        take_another_yes: "ஆம்",
        take_another_done: "முடிந்தது",
        image_delete_btn: "படத்தை நீக்கு",
        image_delete_confirm_title: "இந்தப் படத்தை நீக்கவா?",
        image_delete_confirm_body: "இந்தப் படம் உங்கள் அறிக்கையிலிருந்து நீக்கப்படும்.",
        image_delete_yes: "நீக்கு",
        image_delete_cancel: "ரத்து",
        image_close: "மூடு",
        review_details_title: "விவரங்கள்",
        confirm_title: "உறுதிப்படுத்து",
        rd_status_submitted: "சமர்ப்பிக்கப்பட்டது",
        rd_status_under_review: "மதிப்பாய்வில்",
        rd_status_accepted: "ஏற்கப்பட்டது",
        rd_status_rejected: "நிராகரிக்கப்பட்டது",
        rd_tl_submitted: "சமர்ப்பிக்கப்பட்டது",
        rd_tl_review: "மதிப்பாய்வில்",
        rd_tl_accepted: "ஏற்கப்பட்டது",
        rd_tl_rejected: "நிராகரிக்கப்பட்டது",
        rd_tl_help_sent: "உதவி அனுப்பப்பட்டது",
        rd_meta_location: "இடம்",
        rd_meta_crisis: "நெருக்கடி",
        rd_meta_what: "என்ன",
        rd_meta_damage: "சேதம்",
        rd_meta_severity: "தீவிரம்",
        rd_no_details: "கூடுதல் விவரங்கள் இல்லை.",
        rd_feedback_accepted_title: "உங்கள் அறிக்கை விரைவான பதிலுக்கு உதவியது",
        rd_feedback_awaiting: "ஏற்கப்பட்டது — அனுப்ப காத்திருக்கிறது",
        rd_action_help_arrived: "இடத்திற்கு உதவி வந்தது",
        rd_action_help_dispatched: "உதவி அனுப்பப்பட்டது",
        rd_people_helped_one: "~1 நபருக்கு உதவி",
        rd_people_helped_many: "~{n} பேருக்கு உதவி",
        rd_rejection_default: "இந்த அறிக்கை தவறானது என மதிப்பாய்வாளர்கள் குறித்துள்ளனர்.",
        rd_delete_in_progress: "நீக்கம் நடந்து கொண்டிருக்கிறது. இந்த அறிக்கை 24 மணி நேரத்திற்குள் நிரந்தரமாக நீக்கப்படும்.",
        rd_delete_queued: "இணைக்கப்பட்டதும் நீக்கப்படும்.",
        rd_delete_confirm_prompt: "இந்த அறிக்கையை நீக்கவா?\n\nஉங்கள் தரவு 24 மணி நேரத்திற்குள் நிரந்தரமாக நீக்கப்படும். இதை மாற்ற முடியாது.",
        time_seconds_ago: "{n} வினாடிக்கு முன்",
        time_minutes_ago: "{n} நிமிடம் முன்",
        time_hours_ago: "{n} மணி நேரம் முன்",
        time_1_day_ago: "1 நாள் முன்",
        time_days_ago: "{n} நாட்களுக்கு முன்",
        time_1_month_ago: "1 மாதம் முன்",
        time_months_ago: "{n} மாதங்களுக்கு முன்"
    }
};

const state = {
    lang: 'en',
    photoDataUrl: null,
    photoBlob: null,
    // Guaranteed-delivery pipeline: three JPEG variants of the main photo
    // (SMALL/MEDIUM/LARGE) share a photoGroupId. Populated by
    // ImageVariants.generate() during capture.
    photoVariants: null,   // { small: {blob,bytes}, medium: {...}, large: {...} }
    photoGroupId: null,    // UUID linking the three variants on the backend
    // Extra photos: each entry now carries its own variants + groupId.
    // { dataUrl, blob, variants: {small, medium, large}, groupId }.
    extraPhotos: [],
    audioBlob: null,
    transcript: '',
    description: '',
    infraType: 'ROAD',
    severity: 'MODERATE',
    crisisType: 'FLOOD',
    damageClass: 'PARTIAL',
    infraName: '',
    debrisClearing: false,
    serviceStatus: { electricity: 'UNKNOWN', water: 'UNKNOWN', health: 'UNKNOWN', pressing_needs: [] },
    location: null,
    deviceLocation: null, // Keep original GPS separately
    userLocationName: null, // Place name typed by user (for offline geocoding)
    locationName: null, // Resolved human-readable place name from reverse geocoding
    isRecording: false,
    recognition: null,
    timerInterval: null,
    timerSeconds: 0,
    cameraStream: null,
    speechCode: 'en-US',
    mediaRecorder: null,
    audioChunks: [],
    isAutoSubmit: false,  // Flag to track if this submission is auto-submitted
    inactivityTimeoutMs: 120 * 1000 // 2 minutes in milliseconds
};

// ── Phase 4 (Apr 2026) — Region-gated Auto-Submit Timer ─────────────────────
// When a user taps "Start Report" AND their GPS falls inside an admin-enabled
// region, a 2-minute countdown runs throughout the capture flow. On T=0 the
// report auto-submits whatever has been captured; Cancel at any time returns
// to manual flow.
//
// The geofence config is fetched from GET /api/v1/regions/enabled and cached
// in localStorage for 24 h (offline fallback). If GPS is unavailable or no
// enabled region matches, the timer is never armed.

const _REGION_CACHE_KEY = 'crisp_regions_enabled_v1';
const _REGION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 h
const _AUTO_SUBMIT_MS = 2 * 60 * 1000;              // 2 min

/** Haversine distance in kilometres between two GPS points. */
function _haversineKm(lat1, lng1, lat2, lng2) {
    const toRad = (x) => x * Math.PI / 180;
    const R = 6371; // km
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Fetch enabled regions from the public endpoint, cached in localStorage
 *  with a 24 h TTL. Returns the cached list on network failure (offline). */
async function _fetchEnabledRegions() {
    let cached = null;
    try {
        cached = JSON.parse(localStorage.getItem(_REGION_CACHE_KEY) || 'null');
    } catch (_) {}
    const fresh = cached && cached.ts && (Date.now() - cached.ts < _REGION_CACHE_TTL_MS);
    try {
        const url = (typeof API_BASE !== 'undefined' ? API_BASE : `${window.location.origin.replace(/:\d+$/, ':8000')}/api/v1`) + '/regions/enabled';
        const res = await fetch(url, { method: 'GET' });
        if (res.ok) {
            const data = await res.json();
            const payload = { ts: Date.now(), data };
            localStorage.setItem(_REGION_CACHE_KEY, JSON.stringify(payload));
            return data;
        }
    } catch (e) {
        console.warn('[Region] fetch failed, using cache:', e?.message || e);
    }
    return fresh ? cached.data : (cached?.data || []);
}

/** Returns the region the user is currently inside, or null. Never throws. */
async function _findActiveRegion() {
    // GPS.
    if (!navigator.geolocation) {
        console.warn('[Region] no navigator.geolocation — timer disabled');
        return null;
    }
    const pos = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (p) => resolve(p),
            (e) => { console.warn('[Region] GPS error:', e?.message || e); resolve(null); },
            { timeout: 5000, maximumAge: 60000, enableHighAccuracy: false }
        );
    });
    if (!pos) return null;
    const regions = await _fetchEnabledRegions();
    if (!Array.isArray(regions) || regions.length === 0) return null;
    for (const r of regions) {
        const dKm = _haversineKm(pos.coords.latitude, pos.coords.longitude, r.center_lat, r.center_lng);
        if (dKm * 1000 <= r.radius_meters) return r;
    }
    return null;
}

/** Global auto-submit timer — a banner at the top of every stage from
 *  Start Report onwards. User may cancel at any time; otherwise the
 *  report auto-submits at T=0. */
class InactivityManager {
    constructor() {
        this.intervalId = null;
        this.deadline = null;
        this.bannerEl = null;
        this.activeRegion = null;
    }

    _ensureBanner() {
        if (this.bannerEl) return this.bannerEl;
        const el = document.createElement('div');
        el.id = 'auto-submit-banner';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(90deg,#ea580c,#dc2626);color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.25);';
        el.innerHTML =
            `<i class="fa-solid fa-stopwatch" aria-hidden="true"></i>` +
            `<span style="flex:1;">Auto-submitting in <span id="auto-submit-remaining">2:00</span> · ` +
            `<span id="auto-submit-region" style="opacity:0.8;"></span></span>` +
            `<button id="auto-submit-cancel" type="button" style="background:#fff;color:#dc2626;border:0;padding:6px 12px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;" aria-label="Cancel auto-submit">Cancel</button>`;
        document.body.appendChild(el);
        el.querySelector('#auto-submit-cancel').addEventListener('click', () => this.cancel('user'));
        this.bannerEl = el;
        return el;
    }

    /** Try to arm the timer. Called on "Start Report" tap. Returns a promise
     *  that resolves once geofence check is done (arm success or skip). */
    async tryArm() {
        if (this.intervalId) return;   // already armed
        try {
            const region = await _findActiveRegion();
            if (!region) {
                // outside any enabled zone — leave timer off, no banner.
                return;
            }
            this.activeRegion = region;
            this.deadline = Date.now() + _AUTO_SUBMIT_MS;
            this._ensureBanner().style.display = 'flex';
            const regionEl = document.getElementById('auto-submit-region');
            if (regionEl) regionEl.textContent = region.name;
            this.updateDisplay();
            this.intervalId = setInterval(() => this.updateDisplay(), 1000);
        } catch (e) {
            console.warn('[InactivityManager] arm failed:', e?.message || e);
        }
    }

    updateDisplay() {
        const remain = Math.max(0, this.deadline - Date.now());
        const mm = Math.floor(remain / 60000);
        const ss = Math.floor((remain % 60000) / 1000);
        const el = document.getElementById('auto-submit-remaining');
        if (el) el.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
        if (remain <= 0) {
            this._fire();
        }
    }

    _fire() {
        if (!this.intervalId) return;
        clearInterval(this.intervalId);
        this.intervalId = null;
        this.hide();
        if (typeof handleAutoSubmit === 'function') handleAutoSubmit();
    }

    cancel(reason) {
        if (!this.intervalId) return;
        clearInterval(this.intervalId);
        this.intervalId = null;
        this.deadline = null;
        this.activeRegion = null;
        this.hide();
        console.log(`[InactivityManager] cancelled (${reason || 'unknown'})`);
    }

    /** Called from existing stop() / hide() sites. Tears the banner down. */
    stop() { this.cancel('stop'); }
    show() { if (this.bannerEl) this.bannerEl.style.display = 'flex'; }
    hide() {
        if (this.bannerEl) this.bannerEl.style.display = 'none';
        const legacy = document.getElementById('auto-submit-timer');
        if (legacy) legacy.style.display = 'none';
    }

    /** No-op for backward compat with legacy call sites. Reset-on-input
     *  doesn't apply — the timer is a fixed 2-min deadline gated on region,
     *  not an idle-activity watchdog. */
    reset() {}

    start() { this.tryArm(); }
}

// Auto-submit handler (called when inactivity timeout expires)
function handleAutoSubmit() {
    const currentStage = Array.from(document.querySelectorAll('.stage')).find(s => s.classList.contains('active'))?.id;

    // Don't auto-submit on home or success stages
    if (currentStage === 'stage-home' || currentStage === 'stage-success') return;

    // Validate: at least one input must be provided
    if (!hasMinimumInput()) {
        showToast('⚠️ Please add a photo, audio, or text before submitting.');
        inactivityManager.reset();
        return;
    }

    // Mark this submission as auto-submit
    state.isAutoSubmit = true;

    // Auto-submit: capture current state and submit
    if (currentStage === 'stage-photo') {
        goToStage('stage-audio');
    } else if (currentStage === 'stage-audio') {
        if (state.isRecording) state.isRecording = false;
        state.transcript = document.getElementById('live-transcript')?.value || '';
        goToStage('stage-review');
    } else if (currentStage === 'stage-review') {
        state.description = document.getElementById('edit-text')?.value.trim() || '';
        goToStage('stage-send');
    } else if (currentStage === 'stage-send') {
        submitReport();
    }
}

const inactivityManager = new InactivityManager(state.inactivityTimeoutMs, handleAutoSubmit);

// Dynamically resolve backend host so the app works from both localhost (desktop)
// and from the LAN IP (real mobile device on the same Wi-Fi network).
const _backendHost = `http://${window.location.hostname || "localhost"}:8000`;
const API_BASE = `${_backendHost}/api/v1`;

// ── IP Geolocation fallback ────────────────────────────────────────────────────
// Used when GPS is unavailable (macOS desktop, HTTP non-localhost, permission denied).
// All endpoints use HTTPS so this works on both HTTP and HTTPS pages.
// Returns { lat, lng, acc, is_ip_based, country, region } or null on failure.
async function tryIPGeolocation() {
    // Offline-first: never fire outbound HTTP during the capture flow. The
    // device-side browser geolocation remains functional offline (cached GPS
    // last-known position), and the user can always refine the location
    // manually on the review pages. Skipping here keeps the flow free of
    // "Failed to fetch" noise in the console.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return null;
    }
    const TO = 4000;
    // Tier 1: ipwho.is — most reliable free HTTPS, no key required
    try {
        const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(TO) });
        if (res.ok) {
            const d = await res.json();
            if (d && d.latitude && d.longitude && d.success !== false) {
                return { lat: d.latitude, lng: d.longitude, acc: 5000, is_ip_based: true, country: d.country_code, region: d.region };
            }
        }
    } catch (_) {}
    // Tier 2: ipapi.co — rich data but often rate-limited
    try {
        const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(TO) });
        if (res.ok) {
            const d = await res.json();
            if (d && d.latitude && d.longitude && !d.error) {
                return { lat: d.latitude, lng: d.longitude, acc: 5000, is_ip_based: true, country: d.country_code, region: d.region };
            }
        }
    } catch (_) {}
    // Tier 3: freeipapi.com — another free HTTPS fallback
    try {
        const res = await fetch('https://freeipapi.com/api/json', { signal: AbortSignal.timeout(TO) });
        if (res.ok) {
            const d = await res.json();
            if (d && d.latitude && d.longitude) {
                return { lat: d.latitude, lng: d.longitude, acc: 5000, is_ip_based: true, country: d.countryCode, region: d.regionName };
            }
        }
    } catch (_) {}
    return null;
}

// ── Reverse Geocoding (coordinates → place name) ─────────────────────────────
async function reverseGeocode(lat, lng) {
    // Offline-first guard: skip if offline. A blank place name is fine —
    // the review page already falls back to the raw lat/lng string.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return null;
    }
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`,
            { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !data.address) return null;

        const a = data.address;
        // Build a short, readable name: neighbourhood/suburb, city, country
        const parts = [];
        const local = a.neighbourhood || a.suburb || a.hamlet || a.village || a.town || '';
        const city = a.city || a.county || a.state_district || a.state || '';
        if (local) parts.push(local);
        if (city && city !== local) parts.push(city);
        if (a.country) parts.push(a.country);
        return parts.length > 0 ? parts.join(', ') : (data.display_name || null);
    } catch (e) {
        console.log('Reverse geocoding failed (offline?):', e.message);
        return null;
    }
}

// ── Location context cache helpers (module-scope so resolveLocationName can use them) ──
const _LOC_CTX_KEY = 'crisp_loc_ctx';

function _saveLocCtx(lat, lng, acc, name, lang, langLabel, speechCode) {
    try {
        localStorage.setItem(_LOC_CTX_KEY, JSON.stringify({
            lat, lng, acc, name, lang, langLabel, speechCode, ts: Date.now()
        }));
    } catch (_) {}
}

/** Merge-update specific fields in the persisted location context without overwriting others. */
function _patchLocCtx(fields) {
    try {
        const existing = JSON.parse(localStorage.getItem(_LOC_CTX_KEY) || 'null') || {};
        localStorage.setItem(_LOC_CTX_KEY, JSON.stringify({ ...existing, ...fields, ts: Date.now() }));
    } catch (_) {}
}

// Resolve and cache location name, update UI elements showing it
async function resolveLocationName() {
    if (!state.location || (state.location.lat === 0 && state.location.lng === 0)) return;
    // Don't re-resolve if we already have a name for these coords
    if (state.locationName) return;

    const name = await reverseGeocode(state.location.lat, state.location.lng);
    if (name) {
        state.locationName = name;
        // Persist the resolved name so next reload shows it instantly (no "Resolving...")
        _patchLocCtx({ name });
        // Update any visible location displays
        const locCoords = document.getElementById('loc-coords');
        if (locCoords && !state.userLocationName) {
            locCoords.textContent = name;
        }
        const summaryLoc = document.getElementById('summary-loc');
        if (summaryLoc) {
            summaryLoc.textContent = name;
        }
    }
}

// Apr 2026 PR 3 — update the 🟢/🔴 connectivity dot in the lang-switcher
// pill. Called from the online/offline listeners + on boot. Setting
// aria-label + title keeps it accessible.
function _applyOnlineDot(online) {
    const dot = document.getElementById('connectivity-dot');
    if (!dot) return;
    if (online) {
        dot.classList.remove('connectivity-offline');
        dot.classList.add('connectivity-online');
        dot.setAttribute('aria-label', 'Online');
        dot.setAttribute('title', 'Online — tap to re-check');
    } else {
        dot.classList.remove('connectivity-online');
        dot.classList.add('connectivity-offline');
        dot.setAttribute('aria-label', 'Offline — reports will queue');
        dot.setAttribute('title', 'Offline — tap to re-check');
    }
}

// Connectivity probe (Apr 2026, revised).
//
// Earlier iteration polled every 15 s regardless of state (240 calls/hr
// per idle user). That was wasteful — the polling only matters when
// we *actually* have reason to doubt the browser's connectivity hint,
// which is basically the case where `navigator.onLine === false`
// (possibly a lie: captive portal, post-sleep Chrome, missed `online`
// event). When `navigator.onLine === true`, modern browsers are
// reliable enough that we can trust them.
//
// New policy:
//   · Happy path (navigator says online): do NOT poll. Zero idle traffic.
//   · Navigator says offline: poll every 30 s to detect recovery. On
//     first OK response, flip green and stop the loop.
//   · User-initiated (tap the dot): fire one probe immediately,
//     regardless of state. Always works.
//   · Page becomes visible (tab-switch): one probe to confirm state.
//   · Fresh boot: trust `navigator.onLine` and fire ONE probe only if
//     it reports offline, to correct an initial-load lie.
//
// On 1000 idle users happy-path, total idle traffic drops from ~4
// million requests/day to 0.
let _connectivityProbeTimer = null;
const _CONNECTIVITY_PROBE_INTERVAL_OFFLINE = 30000; // 30 s, only when offline
let _connectivityProbeInFlight = false;

function _stopConnectivityProbe() {
    if (_connectivityProbeTimer) {
        clearInterval(_connectivityProbeTimer);
        _connectivityProbeTimer = null;
    }
}

async function _probeConnectivity() {
    if (_connectivityProbeInFlight) return; // avoid dog-piling if slow network
    _connectivityProbeInFlight = true;
    try {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            // Cachebust param so a stale SW/proxy cache can't masquerade as
            // live connectivity. `/regions/enabled` is tiny, public, and
            // already SW-cached — cheap to hit but we want fresh here.
            const res = await fetch(`${API_BASE}/regions/enabled?_cb=${Date.now()}`, {
                method: 'GET',
                signal: ctrl.signal,
                cache: 'no-store',
            });
            clearTimeout(timer);
            if (res && res.ok) {
                _applyOnlineDot(true);
                // Success → we don't need to keep polling. Either we were
                // in the offline-recovery loop (stop it), or this was a
                // one-shot probe (nothing to stop).
                _stopConnectivityProbe();
                return;
            }
        } catch (_) { /* fall through — probe failed */ }
        // Probe failed. If navigator.onLine is true but the probe timed
        // out on a slow link, keep showing green (trust navigator). If
        // navigator says offline too, show red and (if not already)
        // arm the offline-recovery poll.
        const browserOnline = navigator.onLine !== false;
        _applyOnlineDot(browserOnline);
        if (!browserOnline) _ensureOfflineRecoveryPoll();
    } finally {
        _connectivityProbeInFlight = false;
    }
}

// Start the 30-s recovery poll. Idempotent — safe to call repeatedly.
// Only active while the dot is red; stops as soon as a probe succeeds.
function _ensureOfflineRecoveryPoll() {
    if (_connectivityProbeTimer) return;
    _connectivityProbeTimer = setInterval(_probeConnectivity, _CONNECTIVITY_PROBE_INTERVAL_OFFLINE);
}

// ── i18n helpers ───────────────────────────────────────────────────────────────
// Per-key fallback chain: current locale → English → the key itself.
// Previous bug: `(I18N[state.lang] || I18N.en)[key] || key` short-circuited —
// once a non-English dict existed (truthy), missing keys returned the literal
// key (e.g. "CRISIS_LABEL", "COMPLETE_DAMAGE" leaking to Kannada users).
// The new form tries the locale first; if the key is undefined there, tries
// English; only returns the raw key when English is missing it too.
// Mirrors the RN behaviour at crisp-mobile/services/i18n.ts:191.
function t(key) {
    const locale = I18N[state.lang];
    if (locale && Object.prototype.hasOwnProperty.call(locale, key)) return locale[key];
    const en = I18N.en;
    if (en && Object.prototype.hasOwnProperty.call(en, key)) return en[key];
    return key;
}

let _lastAppliedLang = null;
function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const text = t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = text;
        } else {
            el.textContent = text;
        }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    // Apr 2026 i18n-coverage sweep: dynamically-rendered chrome also needs
    // a refresh when the locale CHANGES. Only re-run when state.lang
    // actually differs from the last applied lang — this avoids
    // unnecessary status-since network calls on every boot
    // applyI18n invocation and keeps repeat applyI18n() calls cheap.
    const changed = _lastAppliedLang && _lastAppliedLang !== state.lang;
    _lastAppliedLang = state.lang;
    if (!changed) return;
    try { if (typeof updateSyncBadge === 'function') updateSyncBadge(); } catch (_) {}
    try { if (typeof _renderPartialReports === 'function') _renderPartialReports().catch(() => {}); } catch (_) {}
    try { if (typeof _renderSubmittedReports === 'function') _renderSubmittedReports().catch(() => {}); } catch (_) {}
    try {
        const reviewStage = document.getElementById('stage-review');
        if (reviewStage && reviewStage.classList.contains('active') && state.reviewPage === 2) {
            if (typeof window.__crispRenderReviewSummary === 'function') {
                window.__crispRenderReviewSummary();
            }
        }
    } catch (_) {}
    // Report detail view — if it's currently active, re-render against the
    // last-viewed report so timeline labels, status chip, meta grid, and
    // feedback text all update to the new language.
    try {
        const detailStage = document.getElementById('stage-report-detail');
        if (detailStage && detailStage.classList.contains('active') && _lastRenderedReport) {
            renderReportDetail(_lastRenderedReport);
        }
    } catch (_) {}
}
// Remembered by renderReportDetail so applyI18n() can re-render on lang change.
let _lastRenderedReport = null;

// ── Stage navigation ───────────────────────────────────────────────────────────
const STAGES = ['stage-home', 'stage-photo', 'stage-audio', 'stage-review', 'stage-send', 'stage-success', 'stage-history', 'stage-report-detail'];

// Apr 2026 PR 1 — testability hooks. Mirrors the dashboard pattern from the
// previous sprint (web-dashboard/src/app.js). Exposes the module-scope
// `state` + `goToStage` on window for Playwright E2E access + DevTools
// debugging. Zero production-path effect; safe to keep always-on.
Object.defineProperty(window, 'state', { get: () => state, configurable: true });
window.__crispGoToStage = (id) => goToStage(id);
// Testability hooks for the reconcile E2E spec — let tests seed the IDB
// queue with a stuck in-flight entry and then verify reconcile dequeues it.
window.__crispEnqueueReport = (payload) => enqueueReport(payload);
window.__crispGetAllQueued = () => getAllQueued();
window.__crispReconcileQueue = () => _reconcileQueueAgainstServer();

function goToStage(id) {
    STAGES.forEach(s => document.getElementById(s).classList.remove('active'));
    document.getElementById(id).classList.add('active');

    const idx = STAGES.indexOf(id);
    const pct = idx === 0 ? 0 : Math.round((idx / (STAGES.length - 2)) * 100);
    document.getElementById('progress-bar-fill').style.width = pct + '%';
    document.getElementById('progress-bar-container').style.display = (id === 'stage-home' || id === 'stage-success') ? 'none' : 'block';

    // Apr 2026 UX rewrite — unified 4-step flow-progress bar. Visible on
    // capture stages (photo / audio / review / send); hidden on home,
    // success, history. `updateFlowProgress` colour-codes each step:
    // green ✓ done · accent ● active · red ! missing · grey ○ upcoming.
    updateFlowProgress(id);

    // Refresh home-screen impact metrics on every return to the landing.
    // Cheap (one or two API calls, cacheable), gives users immediate
    // feedback that their reports are counted.
    if (id === 'stage-home') {
        try { updateHomeImpactMetrics(); } catch (e) { console.warn('[Home] metrics:', e); }
    }

    // Phase 6: notify listeners that a stage was entered. The review-stage
    // pager uses this to reset to page 1 each time the user arrives.
    document.dispatchEvent(new CustomEvent('stage-entered', { detail: id }));

    // Manage inactivity timer: show on photo/audio/review, hide on home/success
    if (id === 'stage-home' || id === 'stage-success') {
        inactivityManager.stop();
        inactivityManager.hide();
    } else {
        inactivityManager.show();
        inactivityManager.reset();
        inactivityManager.start();
    }
}

// ── Validation: Check if at least one input (photo, audio, or text) is provided
function hasMinimumInput() {
    return !!(state.photoDataUrl || state.audioBlob || (state.description && state.description.trim()));
}

// ── Apr 2026 UX rewrite — unified flow-progress bar ────────────────────────
// Maps the internal stage names to the 4 user-visible steps:
//   Photo     · stage-photo
//   Details   · stage-audio  (the voice+text step is the "details" kickoff)
//   Review    · stage-review
//   Send      · stage-send
// State per step:
//   done     — the step's required data is captured AND we're past it
//   active   — currently rendering this step
//   missing  — we're past this step but required data wasn't captured
//              (shouldn't normally happen — guards upstream — but the
//              red flag is a recoverable signal if it does)
//   upcoming — future step
function updateFlowProgress(currentStage) {
    const bar = document.getElementById('flow-progress');
    if (!bar) return;
    // Hidden on non-capture stages.
    const CAPTURE_STAGES = ['stage-photo', 'stage-audio', 'stage-review', 'stage-send'];
    const STEP_FOR_STAGE = { 'stage-photo': 1, 'stage-audio': 2, 'stage-review': 3, 'stage-send': 4 };
    if (!CAPTURE_STAGES.includes(currentStage)) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'flex';
    const activeStep = STEP_FOR_STAGE[currentStage];
    // Per-step "have we captured the required thing?" predicates.
    // Photo is mandatory at step 1; Details (audio or text) is mandatory at
    // step 2; Review just needs us to have reached it; Send = submit pressed.
    const stepHasData = {
        1: !!(state.photoDataUrl || state.photoBlob),
        2: !!(state.audioBlob || (state.description && state.description.trim())),
        3: true,   // by the time we're here, the review pages have summarised it
        4: true,
    };
    bar.querySelectorAll('.fp-step').forEach((el) => {
        const step = parseInt(el.getAttribute('data-step') || '0', 10);
        el.classList.remove('fp-done', 'fp-active', 'fp-missing', 'fp-upcoming');
        if (step < activeStep) {
            el.classList.add(stepHasData[step] ? 'fp-done' : 'fp-missing');
        } else if (step === activeStep) {
            el.classList.add('fp-active');
        } else {
            el.classList.add('fp-upcoming');
        }
    });
}

// ── Landing-screen impact metrics ───────────────────────────────────────────
// Fetches community-wide (or device-scoped) counts so a user arriving at
// the home screen immediately sees social proof — "this platform works,
// people report, lives get saved". Falls back to hiding the card on error.
async function updateHomeImpactMetrics() {
    const wrap = document.getElementById('home-impact');
    // April 2026 — renamed to `home-verified-count` because the metric
    // surfaced to users is now "Reports Verified" (quality signal) rather
    // than raw "Reports Submitted" (volume signal). The DOM swap happens
    // in index.html. The fall-through to `home-reports-count` keeps any
    // pre-cached index.html from breaking catastrophically.
    const verifiedEl = document.getElementById('home-verified-count')
        || document.getElementById('home-reports-count');
    const livesEl = document.getElementById('home-lives-count');
    if (!wrap || !verifiedEl || !livesEl) return;
    try {
        const deviceHash = localStorage.getItem('crisp_device_id_v2') ||
                           localStorage.getItem('crisp_device_hash') ||
                           localStorage.getItem('crisp_device_id') || '';
        let verifiedCount = 0;
        let livesImpacted = 0;
        if (deviceHash) {
            // Use status-since as the source of truth for verified-ness,
            // counting only reports the analyst workflow has promoted out
            // of PENDING. This also means deleted reports (which drop off
            // the list) correctly don't contribute to the headline
            // number — resolves the stale-counter UX bug.
            let statusList = null;
            try {
                const statusRes = await fetch(`${API_BASE}/reports/device/${deviceHash}/status-since?since=1970-01-01T00:00:00Z`);
                if (statusRes.ok) statusList = await statusRes.json();
            } catch (_) {}
            if (Array.isArray(statusList)) {
                const VERIFIED_STATES = new Set([
                    'VERIFIED', 'RESPONDING', 'RESOLVED'
                ]);
                verifiedCount = statusList.filter(
                    (r) => r && VERIFIED_STATES.has(String(r.status || '').toUpperCase())
                ).length;
                livesImpacted = statusList.reduce(
                    (n, r) => n + (Number.isFinite(r.lives_impacted) ? r.lives_impacted : 0), 0);
            }
            // Cross-check the profile endpoint — it carries the authoritative
            // ``verified_count`` bumped whenever an analyst dispatches /
            // resolves a report (_mark_report_verified_for_credibility).
            try {
                const profileRes = await fetch(`${API_BASE}/reports/profile/${deviceHash}`);
                if (profileRes.ok) {
                    const p = await profileRes.json();
                    if (Number.isFinite(p.verified_count) && p.verified_count > verifiedCount) {
                        verifiedCount = p.verified_count;
                    }
                    if (Number.isFinite(p.impact_score) && p.impact_score > livesImpacted) {
                        livesImpacted = p.impact_score;
                    }
                }
            } catch (_) {}
        }
        verifiedEl.textContent = _fmtCompactNumber(verifiedCount);
        livesEl.textContent = _fmtCompactNumber(livesImpacted);
        // Only show the card once we have real numbers to display (don't
        // greet fresh installs with "0 verified"). The volume signal is
        // deliberately not displayed — UNDP-incentive policy (§3.8).
        wrap.style.display = (verifiedCount > 0 || livesImpacted > 0) ? 'flex' : 'none';
    } catch (e) {
        console.warn('[Home] impact metrics fetch failed:', e);
        wrap.style.display = 'none';
    }
}

function _fmtCompactNumber(n) {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
}

// ── Language switching ─────────────────────────────────────────────────────────
function setupLangSwitcher() {
    document.querySelectorAll('#lang-switcher button').forEach(btn => {
        btn.addEventListener('click', () => {
            const langCode = btn.dataset.lang;
            // Map the simple en/kn/hi buttons to their BCP-47 speech codes
            const speechMap = { 'en': 'en-IN', 'kn': 'kn-IN', 'hi': 'hi-IN', 'ta': 'ta-IN' };
            const speechCode = speechMap[langCode] || 'en-US';
            activateLang(langCode, speechCode);

            document.querySelectorAll('#lang-switcher button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Persist manual language choice — survives offline reload
            const langLabel = langCode !== 'en' ? btn.textContent.trim() : null;
            _patchLocCtx({ lang: langCode, langLabel, speechCode });
        });
    });
}

// ── Dynamic language detection ────────────────────────────────────────────────
// Complete global mapping: ISO 3166-1 alpha-2 → { code, label (native script), speechCode }
// Covers 190+ countries. Every country maps to its primary official language in native script.
const COUNTRY_LANG_DATA = {
    // ── Asia & Pacific ──
    'IN': { code: 'hi', label: 'हिंदी', speech: 'hi-IN' },
    'BD': { code: 'bn', label: 'বাংলা', speech: 'bn-BD' },
    'PK': { code: 'ur', label: 'اردو', speech: 'ur-PK' },
    'LK': { code: 'si', label: 'සිංහල', speech: 'si-LK' },
    'NP': { code: 'ne', label: 'नेपाली', speech: 'ne-NP' },
    'MM': { code: 'my', label: 'မြန်မာ', speech: 'my-MM' },
    'MY': { code: 'ms', label: 'Bahasa Melayu', speech: 'ms-MY' },
    'TH': { code: 'th', label: 'ไทย', speech: 'th-TH' },
    'VN': { code: 'vi', label: 'Tiếng Việt', speech: 'vi-VN' },
    'ID': { code: 'id', label: 'Bahasa Indonesia', speech: 'id-ID' },
    'PH': { code: 'tl', label: 'Filipino', speech: 'fil-PH' },
    'KH': { code: 'km', label: 'ខ្មែរ', speech: 'km-KH' },
    'LA': { code: 'lo', label: 'ລາວ', speech: 'lo-LA' },
    'CN': { code: 'zh', label: '中文', speech: 'zh-CN' },
    'TW': { code: 'zh', label: '中文', speech: 'zh-TW' },
    'HK': { code: 'zh', label: '中文', speech: 'zh-HK' },
    'JP': { code: 'ja', label: '日本語', speech: 'ja-JP' },
    'KR': { code: 'ko', label: '한국어', speech: 'ko-KR' },
    'MN': { code: 'mn', label: 'Монгол', speech: 'mn-MN' },
    'KZ': { code: 'kk', label: 'Қазақша', speech: 'kk-KZ' },
    'UZ': { code: 'uz', label: 'Oʻzbekcha', speech: 'uz-UZ' },
    'KG': { code: 'ky', label: 'Кыргызча', speech: 'ky-KG' },
    'TJ': { code: 'tg', label: 'Тоҷикӣ', speech: 'tg-TJ' },
    'TM': { code: 'tk', label: 'Türkmençe', speech: 'tk-TM' },
    'AZ': { code: 'az', label: 'Azərbaycan', speech: 'az-AZ' },
    'GE': { code: 'ka', label: 'ქართული', speech: 'ka-GE' },
    'AM': { code: 'hy', label: 'Հայերեն', speech: 'hy-AM' },
    'MV': { code: 'dv', label: 'ދިވެހި', speech: 'dv-MV' },
    'BT': { code: 'dz', label: 'རྫོང་ཁ', speech: 'dz-BT' },
    'SG': { code: 'en', label: 'English', speech: 'en-SG' },
    'BN': { code: 'ms', label: 'Bahasa Melayu', speech: 'ms-BN' },
    'TL': { code: 'pt', label: 'Português', speech: 'pt-TL' },
    'PG': { code: 'en', label: 'English', speech: 'en-PG' },
    'FJ': { code: 'en', label: 'English', speech: 'en-FJ' },
    'WS': { code: 'sm', label: 'Gagana Samoa', speech: 'en-WS' },
    'TO': { code: 'to', label: 'lea fakatonga', speech: 'en-TO' },
    'VU': { code: 'bi', label: 'Bislama', speech: 'en-VU' },
    'SB': { code: 'en', label: 'English', speech: 'en-SB' },
    'NZ': { code: 'en', label: 'English', speech: 'en-NZ' },
    'AU': { code: 'en', label: 'English', speech: 'en-AU' },
    // ── Middle East ──
    'SA': { code: 'ar', label: 'العربية', speech: 'ar-SA' },
    'AE': { code: 'ar', label: 'العربية', speech: 'ar-AE' },
    'IQ': { code: 'ar', label: 'العربية', speech: 'ar-IQ' },
    'SY': { code: 'ar', label: 'العربية', speech: 'ar-SY' },
    'JO': { code: 'ar', label: 'العربية', speech: 'ar-JO' },
    'LB': { code: 'ar', label: 'العربية', speech: 'ar-LB' },
    'KW': { code: 'ar', label: 'العربية', speech: 'ar-KW' },
    'QA': { code: 'ar', label: 'العربية', speech: 'ar-QA' },
    'BH': { code: 'ar', label: 'العربية', speech: 'ar-BH' },
    'OM': { code: 'ar', label: 'العربية', speech: 'ar-OM' },
    'YE': { code: 'ar', label: 'العربية', speech: 'ar-YE' },
    'PS': { code: 'ar', label: 'العربية', speech: 'ar-PS' },
    'TR': { code: 'tr', label: 'Türkçe', speech: 'tr-TR' },
    'IR': { code: 'fa', label: 'فارسی', speech: 'fa-IR' },
    'IL': { code: 'he', label: 'עברית', speech: 'he-IL' },
    'AF': { code: 'ps', label: 'پښتو', speech: 'ps-AF' },
    'CY': { code: 'el', label: 'Ελληνικά', speech: 'el-CY' },
    // ── Africa ──
    'EG': { code: 'ar', label: 'العربية', speech: 'ar-EG' },
    'MA': { code: 'ar', label: 'العربية', speech: 'ar-MA' },
    'DZ': { code: 'ar', label: 'العربية', speech: 'ar-DZ' },
    'TN': { code: 'ar', label: 'العربية', speech: 'ar-TN' },
    'LY': { code: 'ar', label: 'العربية', speech: 'ar-LY' },
    'SD': { code: 'ar', label: 'العربية', speech: 'ar-SD' },
    'MR': { code: 'ar', label: 'العربية', speech: 'ar-MR' },
    'SO': { code: 'so', label: 'Soomaali', speech: 'so-SO' },
    'DJ': { code: 'fr', label: 'Français', speech: 'fr-DJ' },
    'ET': { code: 'am', label: 'አማርኛ', speech: 'am-ET' },
    'ER': { code: 'ti', label: 'ትግርኛ', speech: 'ti-ER' },
    'KE': { code: 'sw', label: 'Kiswahili', speech: 'sw-KE' },
    'TZ': { code: 'sw', label: 'Kiswahili', speech: 'sw-TZ' },
    'UG': { code: 'sw', label: 'Kiswahili', speech: 'sw-UG' },
    'RW': { code: 'rw', label: 'Kinyarwanda', speech: 'rw-RW' },
    'BI': { code: 'rn', label: 'Ikirundi', speech: 'fr-BI' },
    'CD': { code: 'fr', label: 'Français', speech: 'fr-CD' },
    'CG': { code: 'fr', label: 'Français', speech: 'fr-CG' },
    'CF': { code: 'fr', label: 'Français', speech: 'fr-CF' },
    'CM': { code: 'fr', label: 'Français', speech: 'fr-CM' },
    'TD': { code: 'fr', label: 'Français', speech: 'fr-TD' },
    'NE': { code: 'fr', label: 'Français', speech: 'fr-NE' },
    'ML': { code: 'fr', label: 'Français', speech: 'fr-ML' },
    'BF': { code: 'fr', label: 'Français', speech: 'fr-BF' },
    'SN': { code: 'fr', label: 'Français', speech: 'fr-SN' },
    'GN': { code: 'fr', label: 'Français', speech: 'fr-GN' },
    'CI': { code: 'fr', label: 'Français', speech: 'fr-CI' },
    'TG': { code: 'fr', label: 'Français', speech: 'fr-TG' },
    'BJ': { code: 'fr', label: 'Français', speech: 'fr-BJ' },
    'GA': { code: 'fr', label: 'Français', speech: 'fr-GA' },
    'GQ': { code: 'es', label: 'Español', speech: 'es-GQ' },
    'NG': { code: 'en', label: 'English', speech: 'en-NG' },
    'GH': { code: 'en', label: 'English', speech: 'en-GH' },
    'ZA': { code: 'zu', label: 'isiZulu', speech: 'en-ZA' },
    'ZW': { code: 'en', label: 'English', speech: 'en-ZW' },
    'ZM': { code: 'en', label: 'English', speech: 'en-ZM' },
    'MW': { code: 'en', label: 'English', speech: 'en-MW' },
    'MZ': { code: 'pt', label: 'Português', speech: 'pt-MZ' },
    'AO': { code: 'pt', label: 'Português', speech: 'pt-AO' },
    'CV': { code: 'pt', label: 'Português', speech: 'pt-CV' },
    'GW': { code: 'pt', label: 'Português', speech: 'pt-GW' },
    'ST': { code: 'pt', label: 'Português', speech: 'pt-ST' },
    'MG': { code: 'mg', label: 'Malagasy', speech: 'fr-MG' },
    'MU': { code: 'fr', label: 'Français', speech: 'fr-MU' },
    'SC': { code: 'fr', label: 'Français', speech: 'fr-SC' },
    'KM': { code: 'ar', label: 'العربية', speech: 'ar-KM' },
    'NA': { code: 'en', label: 'English', speech: 'en-NA' },
    'BW': { code: 'en', label: 'English', speech: 'en-BW' },
    'LS': { code: 'st', label: 'Sesotho', speech: 'en-LS' },
    'SZ': { code: 'en', label: 'English', speech: 'en-SZ' },
    'SL': { code: 'en', label: 'English', speech: 'en-SL' },
    'LR': { code: 'en', label: 'English', speech: 'en-LR' },
    'GM': { code: 'en', label: 'English', speech: 'en-GM' },
    'SS': { code: 'en', label: 'English', speech: 'en-SS' },
    // ── Europe ──
    'FR': { code: 'fr', label: 'Français', speech: 'fr-FR' },
    'DE': { code: 'de', label: 'Deutsch', speech: 'de-DE' },
    'AT': { code: 'de', label: 'Deutsch', speech: 'de-AT' },
    'CH': { code: 'de', label: 'Deutsch', speech: 'de-CH' },
    'LI': { code: 'de', label: 'Deutsch', speech: 'de-LI' },
    'LU': { code: 'fr', label: 'Français', speech: 'fr-LU' },
    'BE': { code: 'nl', label: 'Nederlands', speech: 'nl-BE' },
    'NL': { code: 'nl', label: 'Nederlands', speech: 'nl-NL' },
    'ES': { code: 'es', label: 'Español', speech: 'es-ES' },
    'PT': { code: 'pt', label: 'Português', speech: 'pt-PT' },
    'IT': { code: 'it', label: 'Italiano', speech: 'it-IT' },
    'GB': { code: 'en', label: 'English', speech: 'en-GB' },
    'IE': { code: 'en', label: 'English', speech: 'en-IE' },
    'US': { code: 'en', label: 'English', speech: 'en-US' },
    'CA': { code: 'en', label: 'English', speech: 'en-CA' },
    'RU': { code: 'ru', label: 'Русский', speech: 'ru-RU' },
    'UA': { code: 'uk', label: 'Українська', speech: 'uk-UA' },
    'BY': { code: 'be', label: 'Беларуская', speech: 'be-BY' },
    'PL': { code: 'pl', label: 'Polski', speech: 'pl-PL' },
    'CZ': { code: 'cs', label: 'Čeština', speech: 'cs-CZ' },
    'SK': { code: 'sk', label: 'Slovenčina', speech: 'sk-SK' },
    'HU': { code: 'hu', label: 'Magyar', speech: 'hu-HU' },
    'RO': { code: 'ro', label: 'Română', speech: 'ro-RO' },
    'MD': { code: 'ro', label: 'Română', speech: 'ro-MD' },
    'BG': { code: 'bg', label: 'Български', speech: 'bg-BG' },
    'RS': { code: 'sr', label: 'Српски', speech: 'sr-RS' },
    'HR': { code: 'hr', label: 'Hrvatski', speech: 'hr-HR' },
    'BA': { code: 'bs', label: 'Bosanski', speech: 'bs-BA' },
    'ME': { code: 'sr', label: 'Srpski', speech: 'sr-ME' },
    'SI': { code: 'sl', label: 'Slovenščina', speech: 'sl-SI' },
    'MK': { code: 'mk', label: 'Македонски', speech: 'mk-MK' },
    'AL': { code: 'sq', label: 'Shqip', speech: 'sq-AL' },
    'XK': { code: 'sq', label: 'Shqip', speech: 'sq-XK' },
    'GR': { code: 'el', label: 'Ελληνικά', speech: 'el-GR' },
    'SE': { code: 'sv', label: 'Svenska', speech: 'sv-SE' },
    'NO': { code: 'no', label: 'Norsk', speech: 'no-NO' },
    'DK': { code: 'da', label: 'Dansk', speech: 'da-DK' },
    'FI': { code: 'fi', label: 'Suomi', speech: 'fi-FI' },
    'IS': { code: 'is', label: 'Íslenska', speech: 'is-IS' },
    'EE': { code: 'et', label: 'Eesti', speech: 'et-EE' },
    'LV': { code: 'lv', label: 'Latviešu', speech: 'lv-LV' },
    'LT': { code: 'lt', label: 'Lietuvių', speech: 'lt-LT' },
    'MT': { code: 'mt', label: 'Malti', speech: 'mt-MT' },
    // ── Americas ──
    'MX': { code: 'es', label: 'Español', speech: 'es-MX' },
    'GT': { code: 'es', label: 'Español', speech: 'es-GT' },
    'HN': { code: 'es', label: 'Español', speech: 'es-HN' },
    'SV': { code: 'es', label: 'Español', speech: 'es-SV' },
    'NI': { code: 'es', label: 'Español', speech: 'es-NI' },
    'CR': { code: 'es', label: 'Español', speech: 'es-CR' },
    'PA': { code: 'es', label: 'Español', speech: 'es-PA' },
    'CU': { code: 'es', label: 'Español', speech: 'es-CU' },
    'DO': { code: 'es', label: 'Español', speech: 'es-DO' },
    'PR': { code: 'es', label: 'Español', speech: 'es-PR' },
    'CO': { code: 'es', label: 'Español', speech: 'es-CO' },
    'VE': { code: 'es', label: 'Español', speech: 'es-VE' },
    'EC': { code: 'es', label: 'Español', speech: 'es-EC' },
    'PE': { code: 'es', label: 'Español', speech: 'es-PE' },
    'BO': { code: 'es', label: 'Español', speech: 'es-BO' },
    'PY': { code: 'es', label: 'Español', speech: 'es-PY' },
    'UY': { code: 'es', label: 'Español', speech: 'es-UY' },
    'AR': { code: 'es', label: 'Español', speech: 'es-AR' },
    'CL': { code: 'es', label: 'Español', speech: 'es-CL' },
    'BR': { code: 'pt', label: 'Português', speech: 'pt-BR' },
    'HT': { code: 'fr', label: 'Français', speech: 'fr-HT' },
    'JM': { code: 'en', label: 'English', speech: 'en-JM' },
    'TT': { code: 'en', label: 'English', speech: 'en-TT' },
    'GY': { code: 'en', label: 'English', speech: 'en-GY' },
    'SR': { code: 'nl', label: 'Nederlands', speech: 'nl-SR' },
    'BZ': { code: 'en', label: 'English', speech: 'en-BZ' },
};

// Sub-national regions where mapping by country alone is not enough (e.g. India)
const REGION_LANG_MAP = [
    { match: ['karnataka', 'bangalore', 'bengaluru', 'mysore', 'hubli'], code: 'kn', label: 'ಕನ್ನಡ',    speech: 'kn-IN' },
    { match: ['tamil nadu', 'tamilnadu'],       code: 'ta', label: 'தமிழ்',    speech: 'ta-IN' },
    { match: ['kerala'],                        code: 'ml', label: 'മലയാളം',   speech: 'ml-IN' },
    { match: ['telangana', 'andhra'],           code: 'te', label: 'తెలుగు',   speech: 'te-IN' },
    { match: ['maharashtra'],                   code: 'mr', label: 'मराठी',    speech: 'mr-IN' },
    { match: ['gujarat'],                       code: 'gu', label: 'ગુજરાતી', speech: 'gu-IN' },
    { match: ['punjab', 'chandigarh', 'haryana'], code: 'pa', label: 'ਪੰਜਾਬੀ', speech: 'pa-IN' },
    { match: ['west bengal', 'kolkata'],        code: 'bn', label: 'বাংলা',    speech: 'bn-IN' },
    { match: ['odisha'],                        code: 'or', label: 'ଓଡ଼ିଆ',    speech: 'en-IN' },
    { match: ['assam', 'meghalaya', 'manipur', 'nagaland', 'mizoram', 'tripura', 'arunachal', 'sikkim'], code: 'as', label: 'অসমীয়া', speech: 'en-IN' },
    { match: ['rajasthan', 'uttar pradesh', 'madhya pradesh', 'bihar', 'jharkhand', 'chhattisgarh', 'uttarakhand', 'himachal', 'delhi', 'india'], code: 'hi', label: 'हिंदी', speech: 'hi-IN' },
];

// The i18n strings that are always needed regardless of language
// For non-pre-loaded languages we use English as base and swap label only
const EXTRA_LANG = {
    ml: { home_title: 'ഒരു സംഭവം റിപ്പോർട്ട് ചെയ്യൂ', start_btn: 'റിപ്പോർട്ട് ആരംഭിക്കുക', use_camera: 'ക്യാമറ', browse: 'ബ്രൗസ്', skip_photo: 'ഒഴിവാക്കുക', next: 'അടുത്തത്', tap_mic: 'സംസാരിക്കാൻ ടാപ്പ് ചെയ്യുക', send_undp: 'UNDP-ലേക്ക് അയയ്ക്കുക', sent_title: 'റിപ്പോർട്ട് അയച്ചു!', home_offline_hint: '📡 ഓഫ്‌ലൈനിലും കുറഞ്ഞ ഇന്റർനെറ്റ് കണക്ടിവിറ്റിയിലും പ്രവർത്തിക്കുന്നു.', home_metric_reports: 'സമർപ്പിച്ച റിപ്പോർട്ടുകൾ', home_metric_lives: 'രക്ഷിച്ച ജീവനുകൾ', fp_photo: 'ഫോട്ടോ', fp_details: 'വിശദാംശങ്ങൾ', fp_review: 'അവലോകനം', fp_send: 'അയയ്ക്കുക', my_reports: 'എന്റെ റിപ്പോർട്ടുകൾ' },
    te: { home_title: 'సంఘటన నివేదించండి', start_btn: 'నివేదిక ప్రారంభించండి', use_camera: 'కెమెరా', browse: 'బ్రౌజ్', skip_photo: 'దాటవేయి', next: 'తదుపరి', tap_mic: 'మాట్లాడటానికి నొక్కండి', send_undp: 'UNDP కు పంపండి', sent_title: 'నివేదిక పంపబడింది!', home_offline_hint: '📡 ఆఫ్‌లైన్‌లో మరియు తక్కువ ఇంటర్నెట్ కనెక్టివిటీలో పనిచేస్తుంది.', home_metric_reports: 'సమర్పించిన నివేదికలు', home_metric_lives: 'కాపాడబడిన ప్రాణాలు', fp_photo: 'ఫోటో', fp_details: 'వివరాలు', fp_review: 'సమీక్షించు', fp_send: 'పంపు', my_reports: 'నా నివేదికలు' },
    mr: { home_title: 'घटना नोंदवा', start_btn: 'अहवाल सुरू करा', use_camera: 'कॅमेरा', browse: 'ब्राउज', skip_photo: 'वगळा', next: 'पुढे', tap_mic: 'बोलण्यासाठी दाबा', send_undp: 'UNDP ला पाठवा', sent_title: 'अहवाल पाठवला!', home_offline_hint: '📡 ऑफलाइन आणि कमी इंटरनेट कनेक्टिव्हिटीमध्ये कार्य करते.', home_metric_reports: 'सबमिट केलेले अहवाल', home_metric_lives: 'वाचवलेले जीव', fp_photo: 'फोटो', fp_details: 'तपशील', fp_review: 'पुनरावलोकन', fp_send: 'पाठवा', my_reports: 'माझे अहवाल' },
    gu: { home_title: 'ઘટનાની જાણ કરો', start_btn: 'રિપોર્ટ શરૂ કરો', use_camera: 'કૅમેરા', browse: 'શોધો', skip_photo: 'છોડો', next: 'આગળ', tap_mic: 'બોલવા દબાવો', send_undp: 'UNDP ને મોકલો', sent_title: 'રિપોર્ट મોकвायो!', home_offline_hint: '📡 ઓફલાઇન અને ઓછી ઇન્ટરનેટ કનેક્ટિવિટીમાં કામ કરે છે.', home_metric_reports: 'સબમિટ કરેલા રિપોર્ટ્સ', home_metric_lives: 'બચાવેલ જીવન', fp_photo: 'ફોટો', fp_details: 'વિગતો', fp_review: 'સમીક્ષા', fp_send: 'મોકલો', my_reports: 'મારા રિપોર્ટ્સ' },
    sw: { home_title: 'Ripoti Tukio', start_btn: 'Anza', use_camera: 'Kamera', browse: 'Tafuta', skip_photo: 'Ruka', next: 'Endelea', tap_mic: 'Rekodi', send_undp: 'Tuma', sent_title: 'Imetumwa!', consent_title: 'Faragha yako ni muhimu', consent_check: 'Nakubali kushiriki data', consent_accept: 'Kubali', home_offline_hint: '📡 Inafanya kazi nje ya mtandao na kwa mtandao wa chini.', home_metric_reports: 'Ripoti Zilizotumwa', home_metric_lives: 'Maisha Yaliyookolewa', fp_photo: 'Picha', fp_details: 'Maelezo', fp_review: 'Kagua', fp_send: 'Tuma', my_reports: 'Ripoti Zangu' },
    // ── UN official + major global languages ──
    // April 2026 UNDP alignment: add the new keys added for the §3.5 crisis
    // taxonomy, §3.4 infra super-types, §3.3 damage rename, §3.8 verified
    // metric, §3.2 building selector, and §3.1 RTL layout notes. Keys are
    // merged into the base locale object below each main definition so the
    // dense packs already translated keep their existing keys intact.
    fr: { home_title: 'Signaler', start_btn: 'Commencer', use_camera: 'Photo', browse: 'Parcourir', skip_photo: 'Passer', next: 'Continuer', tap_mic: 'Appuyez et parlez clairement', send_undp: 'Envoyer', sent_title: 'Envoyé!', consent_title: 'Votre vie privée compte', consent_desc: 'CRISP collecte uniquement les données nécessaires:', consent_loc: 'Localisation — coordonnées GPS', consent_photo: 'Photos — preuves de dégâts', consent_audio: 'Audio — descriptions vocales', consent_no_pii: 'Aucune identité personnelle collectée', consent_shared: 'Données partagées uniquement avec les secours', consent_delete: 'Suppression possible à tout moment', consent_check: 'Je consens au partage de ces données', consent_accept: 'Accepter', delete_my_data: 'Supprimer mes données', your_reports: 'Vos rapports soumis', delete_all: 'Tout supprimer', s2_title: 'Dites-nous ce qui s\'est passé', s2_sub: 'Parlez ou écrivez:', audio_bullet_1: 'Qu\'est-ce qui est endommagé? (maison, route, personnes…)', audio_bullet_2: 'Quelle est la gravité? (petit / grand / détruit)', audio_bullet_3: 'Quelqu\'un est-il blessé ou en danger?', audio_example: 'Exemple: La route est cassée et l\'eau inonde les maisons. 2 personnes sont blessées.', audio_mic_lang: 'Vous pouvez parler dans votre langue', audio_placeholder: 'Exemple: Maison effondrée, une personne piégée', home_offline_hint: '📡 Fonctionne hors ligne et avec une connexion limitée.', home_metric_reports: 'Rapports soumis', home_metric_lives: 'Vies sauvées', fp_photo: 'Photo', fp_details: 'Détails', fp_review: 'Vérifier', fp_send: 'Envoyer', my_reports: 'Mes rapports', in_flight: 'En cours', submitted: 'Envoyé', empty_in_flight: "Rien en cours. Appuyez sur Démarrer pour en créer un.", empty_submitted: 'Rien envoyé pour le moment.', rd_status_submitted: 'Envoyé', rd_status_under_review: 'En examen', rd_status_accepted: 'Accepté', rd_status_rejected: 'Rejeté', rd_tl_submitted: 'Envoyé', rd_tl_review: 'En examen', rd_tl_accepted: 'Accepté', rd_tl_rejected: 'Rejeté', rd_tl_help_sent: 'Aide envoyée', rd_meta_location: 'Lieu', rd_meta_crisis: 'Crise', rd_meta_what: 'Quoi', rd_meta_damage: 'Dégât', rd_meta_severity: 'Gravité', rd_delete_queued: 'Supprimé à la reconnexion.', rd_people_helped_one: '~1 personne aidée', rd_people_helped_many: '~{n} personnes aidées', time_seconds_ago: 'il y a {n}s', time_minutes_ago: 'il y a {n} min', time_hours_ago: 'il y a {n} h', time_1_day_ago: 'il y a 1 jour', time_days_ago: 'il y a {n} jours', time_1_month_ago: 'il y a 1 mois', time_months_ago: 'il y a {n} mois', back: 'Retour', review_details_title: 'Détails', confirm_title: 'Confirmer', summary_incident: 'Incident', summary_details: 'Détails', summary_edit: '✏️ Modifier', summary_needs_prefix: '🆘 Besoins :', summary_debris: '🚛 Déblaiement nécessaire', summary_none: '—', wildfire: 'Feu de forêt', earthquake: 'Tremblement', cyclone: 'Cyclone', hurricane: 'Ouragan', landslide: 'Glissement', pandemic: 'Pandémie', conflict: 'Conflit', other_crisis: 'Autre', road: 'Route', hospital: 'Hôpital', house: 'Maison', power: 'Électricité', school: 'École', telecom: 'Télécoms', government: 'Bâtiment', other: 'Autre', severe: 'Grave', minor: 'Mineur', moderate: 'Modéré', no_damage: 'Aucun dommage', partial_damage: 'Partiel', complete_damage: 'Détruit', destroyed: 'Détruit', unknown: 'Inconnu', working: 'Fonctionne', disrupted: 'Perturbé', needs_label: '🆘 Besoins urgents', food: 'Nourriture', need_water: 'Eau', shelter: 'Abri', medical: 'Médical', security: 'Sécurité' },
    es: { home_title: 'Reportar', start_btn: 'Iniciar', use_camera: 'Cámara', browse: 'Buscar', skip_photo: 'Omitir', next: 'Continuar', tap_mic: 'Toque y hable claramente', send_undp: 'Enviar', sent_title: 'Enviado!', consent_title: 'Su privacidad importa', consent_desc: 'CRISP recopila solo los datos necesarios:', consent_loc: 'Ubicación — coordenadas GPS', consent_photo: 'Fotos — evidencia de daños', consent_audio: 'Audio — descripción por voz', consent_no_pii: 'No se recopila identidad personal', consent_shared: 'Datos solo para equipos de rescate', consent_delete: 'Puede solicitar eliminación', consent_check: 'Consiento compartir estos datos', consent_accept: 'Aceptar', delete_my_data: 'Eliminar mis datos', your_reports: 'Sus informes', delete_all: 'Eliminar todo', s2_title: 'Cuéntenos qué pasó', s2_sub: 'Hable o escriba:', audio_bullet_1: '¿Qué está dañado? (casa, carretera, personas…)', audio_bullet_2: '¿Qué tan grave? (pequeño / grande / destruido)', audio_bullet_3: '¿Hay alguien herido o en peligro?', audio_example: 'Ejemplo: La carretera está rota y el agua inunda las casas. 2 personas están heridas.', audio_mic_lang: 'Puede hablar en su idioma', audio_placeholder: 'Ejemplo: Casa derrumbada, una persona atrapada', home_offline_hint: '📡 Funciona sin conexión y con internet limitado.', home_metric_reports: 'Informes enviados', home_metric_lives: 'Vidas salvadas', fp_photo: 'Foto', fp_details: 'Detalles', fp_review: 'Revisar', fp_send: 'Enviar', my_reports: 'Mis informes', in_flight: 'En vuelo', submitted: 'Enviado', empty_in_flight: 'Nada en vuelo. Toca Iniciar para crear una.', empty_submitted: 'Aún nada enviado.', rd_status_submitted: 'Enviado', rd_status_under_review: 'En revisión', rd_status_accepted: 'Aceptado', rd_status_rejected: 'Rechazado', rd_tl_submitted: 'Enviado', rd_tl_review: 'En revisión', rd_tl_accepted: 'Aceptado', rd_tl_rejected: 'Rechazado', rd_tl_help_sent: 'Ayuda enviada', rd_meta_location: 'Ubicación', rd_meta_crisis: 'Crisis', rd_meta_what: 'Qué', rd_meta_damage: 'Daño', rd_meta_severity: 'Gravedad', rd_delete_queued: 'Se eliminará al conectar.', rd_people_helped_one: '~1 persona ayudada', rd_people_helped_many: '~{n} personas ayudadas', time_seconds_ago: 'hace {n}s', time_minutes_ago: 'hace {n} min', time_hours_ago: 'hace {n} h', time_1_day_ago: 'hace 1 día', time_days_ago: 'hace {n} días', time_1_month_ago: 'hace 1 mes', time_months_ago: 'hace {n} meses', back: 'Atrás', review_details_title: 'Detalles', confirm_title: 'Confirmar', summary_incident: 'Incidente', summary_details: 'Detalles', summary_edit: '✏️ Editar', summary_needs_prefix: '🆘 Necesidades:', summary_debris: '🚛 Remoción de escombros necesaria', summary_none: '—', wildfire: 'Incendio forestal', earthquake: 'Terremoto', cyclone: 'Ciclón', hurricane: 'Huracán', landslide: 'Deslizamiento', pandemic: 'Pandemia', conflict: 'Conflicto', other_crisis: 'Otro', road: 'Carretera', hospital: 'Hospital', house: 'Casa', power: 'Electricidad', school: 'Escuela', telecom: 'Telecom', government: 'Gubernamental', other: 'Otro', severe: 'Severo', minor: 'Leve', moderate: 'Moderado', no_damage: 'Sin daños', partial_damage: 'Parcial', complete_damage: 'Destruido', destroyed: 'Destruido', unknown: 'Desconocido', working: 'Funcionando', disrupted: 'Interrumpido', needs_label: '🆘 Necesidades urgentes', food: 'Comida', need_water: 'Agua', shelter: 'Refugio', medical: 'Médico', security: 'Seguridad' },
    ar: { home_title: 'إبلاغ', start_btn: 'ابدأ', use_camera: 'كاميرا', browse: 'تصفح', skip_photo: 'تخطي', next: 'متابعة', tap_mic: 'اضغط وتحدث بوضوح', send_undp: 'إرسال', sent_title: 'تم!', consent_title: 'خصوصيتك مهمة', consent_desc: 'يجمع CRISP فقط البيانات اللازمة:', consent_loc: 'الموقع — إحداثيات GPS', consent_photo: 'صور — أدلة الأضرار', consent_audio: 'صوت — وصف صوتي', consent_no_pii: 'لا يتم جمع هوية شخصية', consent_shared: 'البيانات للمستجيبين فقط', consent_delete: 'يمكنك طلب الحذف', consent_check: 'أوافق على مشاركة هذه البيانات', consent_accept: 'قبول', delete_my_data: 'حذف بياناتي', your_reports: 'تقاريرك', delete_all: 'حذف الكل', s2_title: 'أخبرنا بما حدث', s2_sub: 'تحدث أو اكتب:', audio_bullet_1: 'ما المتضرر؟ (منزل، طريق، أشخاص…)', audio_bullet_2: 'ما مدى السوء؟ (صغير / كبير / مدمر)', audio_bullet_3: 'هل هناك جرحى أو في خطر؟', audio_example: 'مثال: الطريق مكسور والمياه تغمر المنازل. جريحان.', audio_mic_lang: 'يمكنك التحدث بلغتك', audio_placeholder: 'مثال: انهار المنزل، شخص محاصر', home_offline_hint: '📡 يعمل دون اتصال وفي حالات الإنترنت الضعيف.', home_metric_reports: 'التقارير المرسلة', home_metric_lives: 'الأرواح المنقذة', fp_photo: 'صورة', fp_details: 'تفاصيل', fp_review: 'مراجعة', fp_send: 'إرسال', my_reports: 'تقاريري', in_flight: 'قيد الإرسال', submitted: 'مُرسل', empty_in_flight: 'لا شيء قيد الإرسال. اضغط لبدء تقرير جديد.', empty_submitted: 'لم يُرسل شيء بعد.', rd_status_submitted: 'مُرسل', rd_status_under_review: 'قيد المراجعة', rd_status_accepted: 'مقبول', rd_status_rejected: 'مرفوض', rd_tl_submitted: 'مُرسل', rd_tl_review: 'قيد المراجعة', rd_tl_accepted: 'مقبول', rd_tl_rejected: 'مرفوض', rd_tl_help_sent: 'تم إرسال المساعدة', rd_meta_location: 'الموقع', rd_meta_crisis: 'الأزمة', rd_meta_what: 'ماذا', rd_meta_damage: 'الضرر', rd_meta_severity: 'الخطورة', rd_delete_queued: 'سيُحذف عند الاتصال.', rd_people_helped_one: '~مساعدة شخص واحد', rd_people_helped_many: '~مساعدة {n} أشخاص', time_seconds_ago: 'منذ {n} ث', time_minutes_ago: 'منذ {n} د', time_hours_ago: 'منذ {n} س', time_1_day_ago: 'منذ يوم', time_days_ago: 'منذ {n} أيام', time_1_month_ago: 'منذ شهر', time_months_ago: 'منذ {n} أشهر', back: 'رجوع', review_details_title: 'التفاصيل', confirm_title: 'تأكيد', summary_incident: 'الحادث', summary_details: 'التفاصيل', summary_edit: '✏️ تعديل', summary_needs_prefix: '🆘 الاحتياجات:', summary_debris: '🚛 إزالة الأنقاض مطلوبة', summary_none: '—', wildfire: 'حريق غابات', earthquake: 'زلزال', cyclone: 'إعصار', hurricane: 'إعصار', landslide: 'انهيار أرضي', pandemic: 'جائحة', conflict: 'نزاع', other_crisis: 'أخرى', road: 'طريق', hospital: 'مستشفى', house: 'منزل', power: 'كهرباء', school: 'مدرسة', telecom: 'اتصالات', government: 'مبنى حكومي', other: 'أخرى', severe: 'شديد', minor: 'طفيف', moderate: 'متوسط', no_damage: 'لا ضرر', partial_damage: 'جزئي', complete_damage: 'مدمر', destroyed: 'مدمر', unknown: 'غير معروف', working: 'يعمل', disrupted: 'معطل', needs_label: '🆘 احتياجات عاجلة', food: 'طعام', need_water: 'ماء', shelter: 'مأوى', medical: 'طبي', security: 'أمن' },
    ru: { home_title: 'Сообщить о происшествии', start_btn: 'Начать', use_camera: 'Камера', browse: 'Обзор', skip_photo: 'Пропустить', next: 'Далее', tap_mic: 'Говорить', send_undp: 'Отправить', sent_title: 'Отправлено!', consent_title: 'Ваша конфиденциальность важна', consent_check: 'Я согласен на передачу данных', consent_accept: 'Принять', home_offline_hint: '📡 Работает офлайн и при слабом интернете.', home_metric_reports: 'Отправленные отчёты', home_metric_lives: 'Спасённые жизни', fp_photo: 'Фото', fp_details: 'Детали', fp_review: 'Проверка', fp_send: 'Отправить', my_reports: 'Мои отчёты', in_flight: 'Отправляется', submitted: 'Отправлено', empty_in_flight: 'Ничего не отправляется. Нажмите Начать для создания.', empty_submitted: 'Пока ничего не отправлено.', rd_status_submitted: 'Отправлено', rd_status_under_review: 'На проверке', rd_status_accepted: 'Принято', rd_status_rejected: 'Отклонено', rd_tl_submitted: 'Отправлено', rd_tl_review: 'На проверке', rd_tl_accepted: 'Принято', rd_tl_rejected: 'Отклонено', rd_tl_help_sent: 'Помощь отправлена', rd_meta_location: 'Место', rd_meta_crisis: 'Кризис', rd_meta_what: 'Что', rd_meta_damage: 'Ущерб', rd_meta_severity: 'Тяжесть', rd_delete_queued: 'Удалится при подключении.', rd_people_helped_one: '~помощь 1 человеку', rd_people_helped_many: '~помощь {n} людям', time_seconds_ago: '{n}с назад', time_minutes_ago: '{n} мин назад', time_hours_ago: '{n} ч назад', time_1_day_ago: '1 день назад', time_days_ago: '{n} дней назад', time_1_month_ago: '1 месяц назад', time_months_ago: '{n} месяцев назад', back: 'Назад', review_details_title: 'Детали', confirm_title: 'Подтвердить', summary_incident: 'Инцидент', summary_details: 'Детали', summary_edit: '✏️ Изменить', summary_needs_prefix: '🆘 Нужды:', summary_debris: '🚛 Нужна уборка обломков', summary_none: '—', wildfire: 'Лесной пожар', earthquake: 'Землетрясение', cyclone: 'Циклон', hurricane: 'Ураган', landslide: 'Оползень', pandemic: 'Пандемия', conflict: 'Конфликт', other_crisis: 'Другое', road: 'Дорога', hospital: 'Больница', house: 'Дом', power: 'Электричество', school: 'Школа', telecom: 'Связь', government: 'Здание', other: 'Другое', severe: 'Тяжёлое', minor: 'Лёгкое', moderate: 'Среднее', no_damage: 'Нет ущерба', partial_damage: 'Частично', complete_damage: 'Разрушено', destroyed: 'Разрушено', unknown: 'Неизвестно', working: 'Работает', disrupted: 'Прервано', needs_label: '🆘 Срочные нужды', food: 'Еда', need_water: 'Вода', shelter: 'Убежище', medical: 'Медицина', security: 'Безопасность' },
    zh: { home_title: '报告', start_btn: '开始', use_camera: '相机', browse: '浏览', skip_photo: '跳过', next: '继续', tap_mic: '点击后清晰地说话', send_undp: '发送', sent_title: '已发送!', consent_title: '您的隐私很重要', consent_check: '我同意分享此数据', consent_accept: '接受', s2_title: '告诉我们发生了什么', s2_sub: '说话或输入:', audio_bullet_1: '什么受损了？（房屋、道路、人员…）', audio_bullet_2: '严重程度？（小 / 大 / 完全毁坏）', audio_bullet_3: '有人受伤或处于危险中吗？', audio_example: '示例：道路断裂，水淹房屋。2 人受伤。', audio_mic_lang: '您可以用您的语言说话', audio_placeholder: '示例：房屋倒塌，一人被困', home_offline_hint: '📡 离线和低网络环境下均可使用。', home_metric_reports: '已提交报告', home_metric_lives: '挽救的生命', fp_photo: '照片', fp_details: '详情', fp_review: '审查', fp_send: '发送', my_reports: '我的报告', in_flight: '传输中', submitted: '已提交', empty_in_flight: '没有传输中的报告。点击开始报告以创建。', empty_submitted: '尚未提交任何报告。', rd_status_submitted: '已提交', rd_status_under_review: '审核中', rd_status_accepted: '已接受', rd_status_rejected: '已拒绝', rd_tl_submitted: '已提交', rd_tl_review: '审核中', rd_tl_accepted: '已接受', rd_tl_rejected: '已拒绝', rd_tl_help_sent: '已派出援助', rd_meta_location: '位置', rd_meta_crisis: '危机', rd_meta_what: '什么', rd_meta_damage: '损坏', rd_meta_severity: '严重程度', rd_delete_queued: '连接后将删除。', rd_people_helped_one: '~帮助了1人', rd_people_helped_many: '~帮助了{n}人', time_seconds_ago: '{n}秒前', time_minutes_ago: '{n}分钟前', time_hours_ago: '{n}小时前', time_1_day_ago: '1天前', time_days_ago: '{n}天前', time_1_month_ago: '1个月前', time_months_ago: '{n}个月前', back: '返回', review_details_title: '详情', confirm_title: '确认', summary_incident: '事件', summary_details: '详情', summary_edit: '✏️ 编辑', summary_needs_prefix: '🆘 需求：', summary_debris: '🚛 需要清理碎片', summary_none: '—', wildfire: '野火', earthquake: '地震', cyclone: '气旋', hurricane: '飓风', landslide: '山体滑坡', pandemic: '大流行', conflict: '冲突', other_crisis: '其他', road: '道路', hospital: '医院', house: '房屋', power: '电力', school: '学校', telecom: '电信', government: '政府建筑', other: '其他', severe: '严重', minor: '轻微', moderate: '中等', no_damage: '无损坏', partial_damage: '部分', complete_damage: '完全毁坏', destroyed: '毁坏', unknown: '未知', working: '正常', disrupted: '中断', needs_label: '🆘 紧急需求', food: '食物', need_water: '水', shelter: '避难所', medical: '医疗', security: '安全' },
    pt: { home_title: 'Reportar', start_btn: 'Iniciar', use_camera: 'Câmera', browse: 'Procurar', skip_photo: 'Pular', next: 'Continuar', tap_mic: 'Toque e fale claramente', send_undp: 'Enviar', sent_title: 'Enviado!', consent_title: 'Sua privacidade importa', consent_check: 'Concordo em compartilhar dados', consent_accept: 'Aceitar', s2_title: 'Conte-nos o que aconteceu', s2_sub: 'Fale ou digite:', audio_bullet_1: 'O que está danificado? (casa, estrada, pessoas…)', audio_bullet_2: 'Quão grave é? (pequeno / grande / destruído)', audio_bullet_3: 'Alguém está ferido ou em perigo?', audio_example: 'Exemplo: A estrada está quebrada e a água está inundando casas. 2 pessoas feridas.', audio_mic_lang: 'Você pode falar no seu idioma', audio_placeholder: 'Exemplo: Casa desabou, uma pessoa presa', home_offline_hint: '📡 Funciona offline e com internet limitada.', home_metric_reports: 'Relatórios enviados', home_metric_lives: 'Vidas salvas', fp_photo: 'Foto', fp_details: 'Detalhes', fp_review: 'Revisar', fp_send: 'Enviar', my_reports: 'Meus relatórios', in_flight: 'Em envio', submitted: 'Enviado', empty_in_flight: 'Nada em envio. Toque em Iniciar para criar um.', empty_submitted: 'Nada enviado ainda.', rd_status_submitted: 'Enviado', rd_status_under_review: 'Em análise', rd_status_accepted: 'Aceito', rd_status_rejected: 'Rejeitado', rd_tl_submitted: 'Enviado', rd_tl_review: 'Em análise', rd_tl_accepted: 'Aceito', rd_tl_rejected: 'Rejeitado', rd_tl_help_sent: 'Ajuda enviada', rd_meta_location: 'Local', rd_meta_crisis: 'Crise', rd_meta_what: 'O quê', rd_meta_damage: 'Dano', rd_meta_severity: 'Gravidade', rd_delete_queued: 'Será excluído ao conectar.', rd_people_helped_one: '~1 pessoa ajudada', rd_people_helped_many: '~{n} pessoas ajudadas', time_seconds_ago: 'há {n}s', time_minutes_ago: 'há {n} min', time_hours_ago: 'há {n} h', time_1_day_ago: 'há 1 dia', time_days_ago: 'há {n} dias', time_1_month_ago: 'há 1 mês', time_months_ago: 'há {n} meses', back: 'Voltar', review_details_title: 'Detalhes', confirm_title: 'Confirmar', summary_incident: 'Incidente', summary_details: 'Detalhes', summary_edit: '✏️ Editar', summary_needs_prefix: '🆘 Necessidades:', summary_debris: '🚛 Remoção de detritos necessária', summary_none: '—', wildfire: 'Incêndio florestal', earthquake: 'Terremoto', cyclone: 'Ciclone', hurricane: 'Furacão', landslide: 'Deslizamento', pandemic: 'Pandemia', conflict: 'Conflito', other_crisis: 'Outro', road: 'Estrada', hospital: 'Hospital', house: 'Casa', power: 'Energia', school: 'Escola', telecom: 'Telecom', government: 'Prédio governamental', other: 'Outro', severe: 'Grave', minor: 'Leve', moderate: 'Moderado', no_damage: 'Sem danos', partial_damage: 'Parcial', complete_damage: 'Destruído', destroyed: 'Destruído', unknown: 'Desconhecido', working: 'Funcionando', disrupted: 'Interrompido', needs_label: '🆘 Necessidades urgentes', food: 'Comida', need_water: 'Água', shelter: 'Abrigo', medical: 'Médico', security: 'Segurança' },
    de: { home_title: 'Vorfall melden', start_btn: 'Starten', use_camera: 'Kamera', browse: 'Suchen', skip_photo: 'Überspringen', next: 'Weiter', tap_mic: 'Sprechen', send_undp: 'Senden', sent_title: 'Gesendet!', consent_title: 'Ihre Privatsphäre ist wichtig', consent_check: 'Ich stimme der Datenweitergabe zu', consent_accept: 'Akzeptieren', home_offline_hint: '📡 Funktioniert offline und bei schlechter Internetverbindung.', home_metric_reports: 'Übermittelte Berichte', home_metric_lives: 'Gerettete Leben', fp_photo: 'Foto', fp_details: 'Details', fp_review: 'Prüfen', fp_send: 'Senden', my_reports: 'Meine Berichte', in_flight: 'Im Versand', submitted: 'Gesendet', empty_in_flight: 'Nichts im Versand. Tippen Sie auf Starten, um einen Bericht zu erstellen.', empty_submitted: 'Noch nichts gesendet.', rd_status_submitted: 'Gesendet', rd_status_under_review: 'In Prüfung', rd_status_accepted: 'Angenommen', rd_status_rejected: 'Abgelehnt', rd_tl_submitted: 'Gesendet', rd_tl_review: 'In Prüfung', rd_tl_accepted: 'Angenommen', rd_tl_rejected: 'Abgelehnt', rd_tl_help_sent: 'Hilfe gesendet', rd_meta_location: 'Ort', rd_meta_crisis: 'Krise', rd_meta_what: 'Was', rd_meta_damage: 'Schaden', rd_meta_severity: 'Schweregrad', rd_delete_queued: 'Wird bei Verbindung gelöscht.', rd_people_helped_one: '~1 Person geholfen', rd_people_helped_many: '~{n} Personen geholfen', time_seconds_ago: 'vor {n}s', time_minutes_ago: 'vor {n} min', time_hours_ago: 'vor {n} h', time_1_day_ago: 'vor 1 Tag', time_days_ago: 'vor {n} Tagen', time_1_month_ago: 'vor 1 Monat', time_months_ago: 'vor {n} Monaten', back: 'Zurück', review_details_title: 'Details', confirm_title: 'Bestätigen', summary_incident: 'Vorfall', summary_details: 'Details', summary_edit: '✏️ Bearbeiten', summary_needs_prefix: '🆘 Bedarf:', summary_debris: '🚛 Trümmerbeseitigung nötig', summary_none: '—', wildfire: 'Waldbrand', earthquake: 'Erdbeben', cyclone: 'Zyklon', hurricane: 'Hurrikan', landslide: 'Erdrutsch', pandemic: 'Pandemie', conflict: 'Konflikt', other_crisis: 'Sonstiges', road: 'Straße', hospital: 'Krankenhaus', house: 'Haus', power: 'Strom', school: 'Schule', telecom: 'Telekom', government: 'Gebäude', other: 'Sonstiges', severe: 'Schwer', minor: 'Leicht', moderate: 'Mittel', no_damage: 'Kein Schaden', partial_damage: 'Teilweise', complete_damage: 'Zerstört', destroyed: 'Zerstört', unknown: 'Unbekannt', working: 'Funktioniert', disrupted: 'Gestört', needs_label: '🆘 Dringender Bedarf', food: 'Essen', need_water: 'Wasser', shelter: 'Unterkunft', medical: 'Medizin', security: 'Sicherheit' },
    it: { home_title: 'Segnala un evento', start_btn: 'Inizia', use_camera: 'Foto', browse: 'Sfoglia', skip_photo: 'Salta', next: 'Avanti', tap_mic: 'Parla', send_undp: 'Invia', sent_title: 'Inviato!', consent_title: 'La tua privacy è importante', consent_check: 'Acconsento alla condivisione dei dati', consent_accept: 'Accetta', home_offline_hint: '📡 Funziona offline e con internet limitato.', home_metric_reports: 'Rapporti inviati', home_metric_lives: 'Vite salvate', fp_photo: 'Foto', fp_details: 'Dettagli', fp_review: 'Controlla', fp_send: 'Invia', my_reports: 'I miei rapporti' },
    tr: { home_title: 'Olay bildir', start_btn: 'Başla', use_camera: 'Kamera', browse: 'Ara', skip_photo: 'Atla', next: 'İleri', tap_mic: 'Konuş', send_undp: 'Gönder', sent_title: 'Gönderildi!', consent_title: 'Gizliliğiniz önemli', consent_check: 'Veri paylaşmayı kabul ediyorum', consent_accept: 'Kabul et', home_offline_hint: '📡 Çevrimdışı ve zayıf internet bağlantısında çalışır.', home_metric_reports: 'Gönderilen raporlar', home_metric_lives: 'Kurtarılan hayatlar', fp_photo: 'Fotoğraf', fp_details: 'Detaylar', fp_review: 'İncele', fp_send: 'Gönder', my_reports: 'Raporlarım' },
    uk: { home_title: 'Повідомити про інцидент', start_btn: 'Почати', use_camera: 'Камера', browse: 'Огляд', skip_photo: 'Пропустити', next: 'Далі', tap_mic: 'Записати', send_undp: 'Надіслати', sent_title: 'Надіслано!', consent_title: 'Ваша конфіденційність важлива', consent_check: 'Я погоджуюсь на передачу даних', consent_accept: 'Прийняти', home_offline_hint: "📡 Працює офлайн і за поганого інтернет-з'єднання.", home_metric_reports: 'Надіслані звіти', home_metric_lives: 'Врятовані життя', fp_photo: 'Фото', fp_details: 'Деталі', fp_review: 'Перевірити', fp_send: 'Надіслати', my_reports: 'Мої звіти' },
    ja: { home_title: '事件を報告', start_btn: '開始', use_camera: 'カメラ', browse: '参照', skip_photo: 'スキップ', next: '次へ', tap_mic: '話す', send_undp: '送信', sent_title: '送信済み!', consent_title: 'プライバシーについて', consent_check: 'データ共有に同意します', consent_accept: '同意', home_offline_hint: '📡 オフラインや低速接続でも動作します。', home_metric_reports: '送信したレポート', home_metric_lives: '救われた命', fp_photo: '写真', fp_details: '詳細', fp_review: '確認', fp_send: '送信', my_reports: 'マイレポート', in_flight: '送信中', submitted: '送信済み', empty_in_flight: '送信中はありません。新規作成するには開始をタップ。', empty_submitted: 'まだ送信されていません。', rd_status_submitted: '送信済み', rd_status_under_review: '審査中', rd_status_accepted: '承認済み', rd_status_rejected: '拒否', rd_tl_submitted: '送信済み', rd_tl_review: '審査中', rd_tl_accepted: '承認済み', rd_tl_rejected: '拒否', rd_tl_help_sent: '救援派遣済み', rd_meta_location: '場所', rd_meta_crisis: '危機', rd_meta_what: '何', rd_meta_damage: '損傷', rd_meta_severity: '重大度', rd_delete_queued: '接続時に削除されます。', rd_people_helped_one: '~1人を救助', rd_people_helped_many: '~{n}人を救助', time_seconds_ago: '{n}秒前', time_minutes_ago: '{n}分前', time_hours_ago: '{n}時間前', time_1_day_ago: '1日前', time_days_ago: '{n}日前', time_1_month_ago: '1ヶ月前', time_months_ago: '{n}ヶ月前', back: '戻る', review_details_title: '詳細', confirm_title: '確認', summary_incident: '事件', summary_details: '詳細', summary_edit: '✏️ 編集', summary_needs_prefix: '🆘 必要:', summary_debris: '🚛 がれき撤去が必要', summary_none: '—', wildfire: '山火事', earthquake: '地震', cyclone: 'サイクロン', hurricane: 'ハリケーン', landslide: '地すべり', pandemic: 'パンデミック', conflict: '紛争', other_crisis: 'その他', road: '道路', hospital: '病院', house: '家', power: '電力', school: '学校', telecom: '通信', government: '政府ビル', other: 'その他', severe: '深刻', minor: '軽微', moderate: '中程度', no_damage: '被害なし', partial_damage: '部分的', complete_damage: '全壊', destroyed: '全壊', unknown: '不明', working: '稼働中', disrupted: '中断', needs_label: '🆘 緊急ニーズ', food: '食料', need_water: '水', shelter: '避難所', medical: '医療', security: '治安' },
    ko: { home_title: '사건 신고', start_btn: '시작', use_camera: '카메라', browse: '찾기', skip_photo: '건너뛰기', next: '다음', tap_mic: '말하기', send_undp: '보내기', sent_title: '전송됨!', consent_title: '개인정보 보호', consent_check: '데이터 공유에 동의합니다', consent_accept: '동의', home_offline_hint: '📡 오프라인 및 낮은 인터넷 환경에서도 작동합니다.', home_metric_reports: '제출한 신고', home_metric_lives: '구한 생명', fp_photo: '사진', fp_details: '세부사항', fp_review: '검토', fp_send: '보내기', my_reports: '내 신고', in_flight: '전송 중', submitted: '제출됨', empty_in_flight: '전송 중 항목 없음. 새로 만들려면 시작을 탭하세요.', empty_submitted: '아직 제출되지 않았습니다.', rd_status_submitted: '제출됨', rd_status_under_review: '검토 중', rd_status_accepted: '승인됨', rd_status_rejected: '거부됨', rd_tl_submitted: '제출됨', rd_tl_review: '검토 중', rd_tl_accepted: '승인됨', rd_tl_rejected: '거부됨', rd_tl_help_sent: '지원 파견됨', rd_meta_location: '위치', rd_meta_crisis: '위기', rd_meta_what: '무엇', rd_meta_damage: '피해', rd_meta_severity: '심각도', rd_delete_queued: '연결 시 삭제됩니다.', rd_people_helped_one: '~1명 지원', rd_people_helped_many: '~{n}명 지원', time_seconds_ago: '{n}초 전', time_minutes_ago: '{n}분 전', time_hours_ago: '{n}시간 전', time_1_day_ago: '1일 전', time_days_ago: '{n}일 전', time_1_month_ago: '1달 전', time_months_ago: '{n}달 전', back: '뒤로', review_details_title: '세부사항', confirm_title: '확인', summary_incident: '사건', summary_details: '세부사항', summary_edit: '✏️ 편집', summary_needs_prefix: '🆘 필요:', summary_debris: '🚛 잔해 제거 필요', summary_none: '—', wildfire: '산불', earthquake: '지진', cyclone: '사이클론', hurricane: '허리케인', landslide: '산사태', pandemic: '팬데믹', conflict: '분쟁', other_crisis: '기타', road: '도로', hospital: '병원', house: '집', power: '전기', school: '학교', telecom: '통신', government: '정부 건물', other: '기타', severe: '심각', minor: '경미', moderate: '중간', no_damage: '피해 없음', partial_damage: '부분', complete_damage: '파괴', destroyed: '파괴', unknown: '알 수 없음', working: '작동 중', disrupted: '중단', needs_label: '🆘 긴급 필요', food: '음식', need_water: '물', shelter: '대피소', medical: '의료', security: '보안' },
    am: { home_title: 'ክስተት ሪፖርት ያድርጉ', start_btn: 'ጀምር', use_camera: 'ካሜራ', browse: 'ፈልግ', skip_photo: 'ዝለል', next: 'ቀጣይ', tap_mic: 'ንካ', send_undp: 'ላክ', sent_title: 'ተልኳል!', consent_title: 'ግላዊነትዎ ጠቃሚ', consent_check: 'ዳታ ማጋራት እስማማለሁ', consent_accept: 'ተቀበል', home_offline_hint: '📡 ከመስመር ውጭ እና በዝቅተኛ ኢንተርኔት ግንኙነት ይሰራል።', home_metric_reports: 'የቀረቡ ሪፖርቶች', home_metric_lives: 'የዳኑ ሕይወቶች', fp_photo: 'ፎቶ', fp_details: 'ዝርዝሮች', fp_review: 'ገምግም', fp_send: 'ላክ', my_reports: 'የእኔ ሪፖርቶች' },
    ur: { home_title: 'واقعہ رپورٹ کریں', start_btn: 'شروع', use_camera: 'کیمرا', browse: 'تلاش', skip_photo: 'چھوڑیں', next: 'جاری رکھیں', back: 'پیچھے', tap_mic: 'بولیں', send_undp: 'بھیجیں', sent_title: 'بھیج دیا!', consent_title: 'آپ کی رازداری اہم ہے', consent_check: 'ڈیٹا شیئر کرنے پر متفق', consent_accept: 'قبول', home_offline_hint: '📡 آف لائن اور کم انٹرنیٹ کنیکٹوٹی میں کام کرتا ہے۔', home_metric_reports: 'جمع کرائی گئی رپورٹیں', home_metric_lives: 'بچائی گئی زندگیاں', fp_photo: 'تصویر', fp_details: 'تفصیلات', fp_review: 'جائزہ', fp_send: 'بھیجیں', my_reports: 'میری رپورٹیں', in_flight: 'پرواز میں', submitted: 'جمع کرائی گئی', empty_in_flight: 'پرواز میں کچھ نہیں۔ نئی رپورٹ شروع کرنے کے لیے ٹیپ کریں۔', empty_submitted: 'ابھی تک کچھ جمع نہیں کرایا گیا۔', rd_status_submitted: 'جمع کرائی گئی', rd_status_under_review: 'جائزے میں', rd_status_accepted: 'منظور', rd_status_rejected: 'مسترد', rd_tl_submitted: 'جمع کرائی گئی', rd_tl_review: 'جائزے میں', rd_tl_accepted: 'منظور', rd_tl_rejected: 'مسترد', rd_tl_help_sent: 'مدد بھیجی گئی', rd_meta_location: 'مقام', rd_meta_crisis: 'بحران', rd_meta_what: 'کیا', rd_meta_damage: 'نقصان', rd_meta_severity: 'شدت', rd_feedback_accepted_title: 'آپ کی رپورٹ نے تیز ردعمل میں مدد کی', rd_feedback_awaiting: 'منظور — بھیجنے کا انتظار', rd_action_help_arrived: 'مدد موقع پر پہنچ گئی', rd_action_help_dispatched: 'مدد بھیج دی گئی', rd_people_helped_one: '~1 فرد کی مدد', rd_people_helped_many: '~{n} افراد کی مدد', rd_rejection_default: 'جائزہ کاروں نے اس رپورٹ کو غیر معتبر قرار دیا۔', rd_delete_in_progress: 'حذف جاری ہے۔ یہ رپورٹ 24 گھنٹوں میں مستقل طور پر ہٹا دی جائے گی۔', rd_delete_queued: 'کنکشن ہونے پر حذف ہو جائے گا۔', rd_delete_confirm_prompt: 'یہ رپورٹ حذف کریں؟\n\nآپ کا ڈیٹا 24 گھنٹوں میں مستقل ہٹا دیا جائے گا۔ یہ واپس نہیں ہوگا۔', time_seconds_ago: '{n} سیکنڈ پہلے', time_minutes_ago: '{n} منٹ پہلے', time_hours_ago: '{n} گھنٹے پہلے', time_1_day_ago: '1 دن پہلے', time_days_ago: '{n} دن پہلے', time_1_month_ago: '1 مہینہ پہلے', time_months_ago: '{n} مہینے پہلے', review_details_title: 'تفصیلات', confirm_title: 'تصدیق کریں', summary_incident: 'واقعہ', summary_details: 'تفصیلات', summary_edit: '✏️ ترمیم', summary_needs_prefix: '🆘 ضروریات:', summary_debris: '🚛 ملبہ ہٹانے کی ضرورت', summary_none: '—', description_label: 'تفصیل', crisis_label: 'کیا وجہ تھی؟', damage_label: 'کتنا نقصان؟', severity_label: 'شدت؟', service_label: 'اختیاری: سروس کی حالت', needs_label: '🆘 فوری ضروریات', what_damaged: 'کیا نقصان ہوا؟', earthquake: 'زلزلہ', flood: 'سیلاب', conflict: 'تنازع', hurricane: 'سمندری طوفان', cyclone: 'سمندری طوفان', wildfire: 'جنگل کی آگ', landslide: 'زمینی تودہ', pandemic: 'وبا', other_crisis: 'دیگر', road: 'سڑک', hospital: 'ہسپتال', house: 'گھر', power: 'بجلی', water: 'پانی', school: 'اسکول', telecom: 'مواصلات', government: 'سرکاری عمارت', other: 'دیگر', severity_minor: 'معمولی', minor: 'معمولی', moderate: 'اعتدال پسند', severe: 'شدید', no_damage: 'کوئی نقصان نہیں', partial_damage: 'جزوی', complete_damage: 'مکمل تباہ', destroyed: 'تباہ', electricity: '⚡ بجلی', water_svc: '💧 پانی', health_svc: '🏥 صحت', unknown: 'نامعلوم', working: 'کام کر رہا ہے', disrupted: 'متاثر', food: 'خوراک', need_water: 'پانی', shelter: 'پناہ', medical: 'طبی', security: 'سلامتی' },
    ne: { home_title: 'घटना रिपोर्ट गर्नुहोस्', start_btn: 'सुरु', use_camera: 'क्यामेरा', browse: 'खोज', skip_photo: 'छोड्नुहोस्', next: 'अर्को', tap_mic: 'बोल्नुहोस्', send_undp: 'पठाउ', sent_title: 'पठाइयो!', consent_title: 'तपाईंको गोपनीयता महत्त्वपूर्ण', consent_check: 'डाटा साझा गर्न सहमत', consent_accept: 'स्वीकार', home_offline_hint: '📡 अफलाइन र कम इन्टरनेट कनेक्टिविटीमा काम गर्छ।', home_metric_reports: 'पेश गरिएका रिपोर्टहरू', home_metric_lives: 'बचाइएका जीवनहरू', fp_photo: 'फोटो', fp_details: 'विवरण', fp_review: 'समीक्षा', fp_send: 'पठाउ', my_reports: 'मेरा रिपोर्टहरू' },
    th: { home_title: 'รายงานเหตุการณ์', start_btn: 'เริ่ม', use_camera: 'กล้อง', browse: 'ค้นหา', skip_photo: 'ข้าม', next: 'ถัดไป', tap_mic: 'พูด', send_undp: 'ส่ง', sent_title: 'ส่งแล้ว!', consent_title: 'ความเป็นส่วนตัวสำคัญ', consent_check: 'ยินยอมแบ่งปันข้อมูล', consent_accept: 'ยอมรับ', home_offline_hint: '📡 ทำงานแบบออฟไลน์และการเชื่อมต่ออินเทอร์เน็ตต่ำ', home_metric_reports: 'รายงานที่ส่ง', home_metric_lives: 'ชีวิตที่รอด', fp_photo: 'รูป', fp_details: 'รายละเอียด', fp_review: 'ตรวจสอบ', fp_send: 'ส่ง', my_reports: 'รายงานของฉัน' },
    vi: { home_title: 'Báo cáo sự cố', start_btn: 'Bắt đầu', use_camera: 'Máy ảnh', browse: 'Duyệt', skip_photo: 'Bỏ qua', next: 'Tiếp', tap_mic: 'Nói', send_undp: 'Gửi', sent_title: 'Đã gửi!', consent_title: 'Quyền riêng tư quan trọng', consent_check: 'Tôi đồng ý chia sẻ dữ liệu', consent_accept: 'Chấp nhận', home_offline_hint: '📡 Hoạt động khi không có mạng hoặc mạng yếu.', home_metric_reports: 'Báo cáo đã gửi', home_metric_lives: 'Mạng sống được cứu', fp_photo: 'Ảnh', fp_details: 'Chi tiết', fp_review: 'Xem lại', fp_send: 'Gửi', my_reports: 'Báo cáo của tôi' },
    id: { home_title: 'Laporkan Kejadian', start_btn: 'Mulai', use_camera: 'Kamera', browse: 'Cari', skip_photo: 'Lewati', next: 'Lanjut', tap_mic: 'Bicara', send_undp: 'Kirim', sent_title: 'Terkirim!', consent_title: 'Privasi Anda penting', consent_check: 'Saya setuju membagikan data', consent_accept: 'Terima', home_offline_hint: '📡 Bekerja offline dan di koneksi internet rendah.', home_metric_reports: 'Laporan terkirim', home_metric_lives: 'Nyawa terselamatkan', fp_photo: 'Foto', fp_details: 'Detail', fp_review: 'Tinjau', fp_send: 'Kirim', my_reports: 'Laporan Saya' },
    ms: { home_title: 'Laporkan Kejadian', start_btn: 'Mula', use_camera: 'Kamera', browse: 'Cari', skip_photo: 'Langkau', next: 'Seterusnya', tap_mic: 'Bercakap', send_undp: 'Hantar', sent_title: 'Dihantar!', consent_title: 'Privasi anda penting', consent_check: 'Saya bersetuju berkongsi data', consent_accept: 'Terima', home_offline_hint: '📡 Berfungsi luar talian dan pada sambungan internet rendah.', home_metric_reports: 'Laporan dihantar', home_metric_lives: 'Nyawa diselamatkan', fp_photo: 'Foto', fp_details: 'Butiran', fp_review: 'Semak', fp_send: 'Hantar', my_reports: 'Laporan saya' },
    km: { home_title: 'រាយការណ៍ព្រឹត្តិការណ៍', start_btn: 'ចាប់ផ្តើម', use_camera: 'កាមេរ៉ា', browse: 'រុករក', skip_photo: 'រំលង', next: 'បន្ទាប់', tap_mic: 'និយាយ', send_undp: 'ផ្ញើ', sent_title: 'បានផ្ញើ!', consent_title: 'ភាពឯកជនសំខាន់', consent_check: 'ខ្ញុំយល់ព្រមចែករំលែកទិន្នន័យ', consent_accept: 'ទទួលយក', home_offline_hint: '📡 ដំណើរការក្រៅបណ្តាញ និងការតភ្ជាប់អ៊ីនធឺណេតទាប។', home_metric_reports: 'របាយការណ៍បានដាក់បញ្ជូន', home_metric_lives: 'ជីវិតបានសង្គ្រោះ', fp_photo: 'រូបថត', fp_details: 'ព័ត៌មានលម្អិត', fp_review: 'ពិនិត្យ', fp_send: 'ផ្ញើ', my_reports: 'របាយការណ៍របស់ខ្ញុំ' },
    fa: { home_title: 'گزارش حادثه', start_btn: 'شروع', use_camera: 'دوربین', browse: 'مرور', skip_photo: 'رد شو', next: 'بعدی', tap_mic: 'صحبت', send_undp: 'ارسال', sent_title: 'ارسال شد!', consent_title: 'حریم خصوصی شما مهم است', consent_check: 'موافقم داده‌ها را به اشتراک بگذارم', consent_accept: 'قبول', home_offline_hint: '📡 بدون اتصال و در اینترنت کم‌سرعت کار می‌کند.', home_metric_reports: 'گزارش‌های ارسال‌شده', home_metric_lives: 'جان‌های نجات‌یافته', fp_photo: 'عکس', fp_details: 'جزئیات', fp_review: 'بررسی', fp_send: 'ارسال', my_reports: 'گزارش‌های من' },
    my: { home_title: 'ဖြစ်ရပ်တင်ပြပါ', start_btn: 'စတင်', use_camera: 'ကင်မရာ', browse: 'ရှာ', skip_photo: 'ကျော်', next: 'ရှေ့', tap_mic: 'ပြော', send_undp: 'ပို့', sent_title: 'ပို့ပြီး!', consent_title: 'ကိုယ်ရေးအချက်အလက် အရေးကြီးသည်', consent_check: 'ဒေတာမျှဝေရန် သဘောတူသည်', consent_accept: 'လက်ခံ', home_offline_hint: '📡 အော့ဖ်လိုင်းနှင့် အင်တာနက်အနိမ့်တွင် အလုပ်လုပ်သည်။', home_metric_reports: 'တင်သွင်းထားသော အစီရင်ခံစာ', home_metric_lives: 'ကယ်တင်ခဲ့သော အသက်များ', fp_photo: 'ဓာတ်ပုံ', fp_details: 'အသေးစိတ်', fp_review: 'ပြန်လည်စစ်ဆေး', fp_send: 'ပို့', my_reports: 'ကျွန်ုပ်၏ အစီရင်ခံစာ' },
    pl: { home_title: 'Zgłoś zdarzenie', start_btn: 'Rozpocznij', use_camera: 'Aparat', browse: 'Szukaj', skip_photo: 'Pomiń', next: 'Dalej', tap_mic: 'Mów', send_undp: 'Wyślij', sent_title: 'Wysłano!', consent_title: 'Twoja prywatność jest ważna', consent_check: 'Wyrażam zgodę na udostępnienie danych', consent_accept: 'Akceptuj', home_offline_hint: '📡 Działa offline i przy słabym połączeniu.', home_metric_reports: 'Wysłane zgłoszenia', home_metric_lives: 'Uratowane życia', fp_photo: 'Zdjęcie', fp_details: 'Szczegóły', fp_review: 'Sprawdź', fp_send: 'Wyślij', my_reports: 'Moje zgłoszenia' },
    ro: { home_title: 'Raportează incident', start_btn: 'Începe', use_camera: 'Cameră', browse: 'Caută', skip_photo: 'Omite', next: 'Următor', tap_mic: 'Vorbește', send_undp: 'Trimite', sent_title: 'Trimis!', consent_title: 'Confidențialitatea contează', consent_check: 'Sunt de acord să partajez date', consent_accept: 'Accept', home_offline_hint: '📡 Funcționează offline și cu internet limitat.', home_metric_reports: 'Rapoarte trimise', home_metric_lives: 'Vieți salvate', fp_photo: 'Fotografie', fp_details: 'Detalii', fp_review: 'Verifică', fp_send: 'Trimite', my_reports: 'Rapoartele mele' },
    so: { home_title: 'Soo-sheeg dhacdo', start_btn: 'Bilow', use_camera: 'Kamarad', browse: 'Raadi', skip_photo: 'Ka bood', next: 'Xiga', tap_mic: 'Hadal', send_undp: 'Dir', sent_title: 'La diray!', consent_title: 'Asturnaantaadu muhiim', consent_check: 'Waan ogolahay in xogta la wadaago', consent_accept: 'Aqbal', home_offline_hint: '📡 Waxay ku shaqeysaa offline iyo internet-ka hoose.', home_metric_reports: 'Warbixinnada la diray', home_metric_lives: 'Nafaha la badbaadiyay', fp_photo: 'Sawir', fp_details: 'Faahfaahin', fp_review: 'Dib u eeg', fp_send: 'Dir', my_reports: 'Warbixintayda' },
    si: { home_title: 'සිද්ධියක් වාර්තා කරන්න', start_btn: 'ආරම්භ', use_camera: 'කැමරාව', browse: 'සොයන්න', skip_photo: 'මඟ හරින්න', next: 'ඊළඟ', tap_mic: 'කතා කරන්න', send_undp: 'යවන්න', sent_title: 'යැවීය!', consent_title: 'ඔබේ පෞද්ගලිකත්වය වැදගත්', consent_check: 'දත්ත බෙදා ගැනීමට එකඟ', consent_accept: 'පිළිගන්න', home_offline_hint: '📡 නොබැඳි සහ අඩු අන්තර්ජාල සම්බන්ධතාවකින් ක්‍රියාත්මක වේ.', home_metric_reports: 'ඉදිරිපත් කළ වාර්තා', home_metric_lives: 'බේරාගත් ජීවිත', fp_photo: 'ඡායාරූපය', fp_details: 'විස්තර', fp_review: 'සමාලෝචනය', fp_send: 'යවන්න', my_reports: 'මගේ වාර්තා' },
    he: { home_title: 'דווח על אירוע', start_btn: 'התחל', use_camera: 'מצלמה', browse: 'חפש', skip_photo: 'דלג', next: 'הבא', tap_mic: 'דבר', send_undp: 'שלח', sent_title: 'נשלח!', consent_title: 'הפרטיות שלך חשובה', consent_check: 'אני מסכים לשתף נתונים', consent_accept: 'אישור', home_offline_hint: '📡 פועל גם ללא אינטרנט ובחיבור איטי.', home_metric_reports: 'דיווחים שנשלחו', home_metric_lives: 'חיים שניצלו', fp_photo: 'תמונה', fp_details: 'פרטים', fp_review: 'סקירה', fp_send: 'שלח', my_reports: 'הדיווחים שלי' },
    el: { home_title: 'Αναφορά συμβάντος', start_btn: 'Έναρξη', use_camera: 'Κάμερα', browse: 'Αναζήτηση', skip_photo: 'Παράλειψη', next: 'Επόμενο', tap_mic: 'Μιλήστε', send_undp: 'Αποστολή', sent_title: 'Εστάλη!', consent_title: 'Το απόρρητό σας μετράει', consent_check: 'Συμφωνώ να μοιραστώ δεδομένα', consent_accept: 'Αποδοχή', home_offline_hint: '📡 Λειτουργεί εκτός σύνδεσης και σε αργό internet.', home_metric_reports: 'Απεσταλμένες αναφορές', home_metric_lives: 'Ζωές που σώθηκαν', fp_photo: 'Φωτογραφία', fp_details: 'Λεπτομέρειες', fp_review: 'Έλεγχος', fp_send: 'Αποστολή', my_reports: 'Οι αναφορές μου' },
    bn: { home_title: 'রিপোর্ট', start_btn: 'শুরু', use_camera: 'ক্যামেরা', browse: 'খুঁজুন', skip_photo: 'বাদ', next: 'চালিয়ে যান', tap_mic: 'চাপুন এবং স্পষ্টভাবে বলুন', send_undp: 'পাঠান', sent_title: 'পাঠানো হয়েছে!', consent_title: 'আপনার গোপনীয়তা গুরুত্বপূর্ণ', consent_check: 'ডেটা শেয়ার করতে সম্মত', consent_accept: 'গ্রহণ', s2_title: 'কী হয়েছে আমাদের বলুন', s2_sub: 'বলুন বা টাইপ করুন:', audio_bullet_1: 'কী ক্ষতিগ্রস্ত? (বাড়ি, রাস্তা, মানুষ…)', audio_bullet_2: 'কতটা খারাপ? (ছোট / বড় / সম্পূর্ণ ধ্বংস)', audio_bullet_3: 'কেউ আহত বা বিপদে আছে?', audio_example: 'উদাহরণ: রাস্তা ভেঙে গেছে এবং জল বাড়িতে ঢুকছে। 2 জন আহত।', audio_mic_lang: 'আপনি আপনার ভাষায় কথা বলতে পারেন', audio_placeholder: 'উদাহরণ: বাড়ি ধসে গেছে, একজন আটকা পড়েছে', home_offline_hint: '📡 অফলাইন এবং কম ইন্টারনেট সংযোগে কাজ করে।', home_metric_reports: 'জমা দেওয়া রিপোর্ট', home_metric_lives: 'বাঁচানো জীবন', fp_photo: 'ছবি', fp_details: 'বিবরণ', fp_review: 'পর্যালোচনা', fp_send: 'পাঠান', my_reports: 'আমার রিপোর্ট', in_flight: 'পাঠানো হচ্ছে', submitted: 'জমা দেওয়া হয়েছে', empty_in_flight: 'কিছুই পাঠানো হচ্ছে না। নতুন তৈরি করতে শুরু করুন ট্যাপ করুন।', empty_submitted: 'এখনও কিছু জমা দেওয়া হয়নি।', rd_status_submitted: 'জমা দেওয়া', rd_status_under_review: 'পর্যালোচনাধীন', rd_status_accepted: 'গৃহীত', rd_status_rejected: 'প্রত্যাখ্যাত', rd_tl_submitted: 'জমা দেওয়া', rd_tl_review: 'পর্যালোচনাধীন', rd_tl_accepted: 'গৃহীত', rd_tl_rejected: 'প্রত্যাখ্যাত', rd_tl_help_sent: 'সাহায্য পাঠানো হয়েছে', rd_meta_location: 'অবস্থান', rd_meta_crisis: 'সংকট', rd_meta_what: 'কী', rd_meta_damage: 'ক্ষতি', rd_meta_severity: 'তীব্রতা', rd_delete_queued: 'সংযোগ হলে মুছে যাবে।', rd_people_helped_one: '~১ জনকে সাহায্য', rd_people_helped_many: '~{n} জনকে সাহায্য', time_seconds_ago: '{n} সেকেন্ড আগে', time_minutes_ago: '{n} মিনিট আগে', time_hours_ago: '{n} ঘন্টা আগে', time_1_day_ago: '১ দিন আগে', time_days_ago: '{n} দিন আগে', time_1_month_ago: '১ মাস আগে', time_months_ago: '{n} মাস আগে', back: 'পিছনে', review_details_title: 'বিবরণ', confirm_title: 'নিশ্চিত করুন', summary_incident: 'ঘটনা', summary_details: 'বিবরণ', summary_edit: '✏️ সম্পাদনা', summary_needs_prefix: '🆘 প্রয়োজন:', summary_debris: '🚛 ধ্বংসাবশেষ পরিষ্কার দরকার', summary_none: '—', wildfire: 'বনাগ্নি', earthquake: 'ভূমিকম্প', cyclone: 'ঘূর্ণিঝড়', hurricane: 'হারিকেন', landslide: 'ভূমিধ্বস', pandemic: 'মহামারী', conflict: 'সংঘাত', other_crisis: 'অন্যান্য', road: 'রাস্তা', hospital: 'হাসপাতাল', house: 'বাড়ি', power: 'বিদ্যুৎ', school: 'স্কুল', telecom: 'টেলিকম', government: 'সরকারি ভবন', other: 'অন্যান্য', severe: 'গুরুতর', minor: 'সামান্য', moderate: 'মাঝারি', no_damage: 'ক্ষতি নেই', partial_damage: 'আংশিক', complete_damage: 'ধ্বংস', destroyed: 'ধ্বংস', unknown: 'অজানা', working: 'কাজ করছে', disrupted: 'বিঘ্নিত', needs_label: '🆘 জরুরি প্রয়োজন', food: 'খাবার', need_water: 'পানি', shelter: 'আশ্রয়', medical: 'চিকিৎসা', security: 'নিরাপত্তা' },
    pa: { home_title: 'ਘਟਨਾ ਦੀ ਰਿਪੋਰਟ ਕਰੋ', start_btn: 'ਸ਼ੁਰੂ', use_camera: 'ਕੈਮਰਾ', browse: 'ਖੋਜੋ', skip_photo: 'ਛੱਡੋ', next: 'ਅੱਗੇ', tap_mic: 'ਦਬਾਓ', send_undp: 'ਭੇਜੋ', sent_title: 'ਭੇਜਿਆ!', consent_title: 'ਤੁਹਾਡੀ ਗੋਪਨੀਯਤਾ ਮਹੱਤਵਪੂਰਨ', consent_check: 'ਡੇਟਾ ਸਾਂਝਾ ਕਰਨ ਲਈ ਸਹਿਮਤ', consent_accept: 'ਸਵੀਕਾਰ', home_offline_hint: '📡 ਆਫਲਾਈਨ ਅਤੇ ਘੱਟ ਇੰਟਰਨੈੱਟ ਕਨੈਕਟੀਵਿਟੀ ਵਿੱਚ ਕੰਮ ਕਰਦਾ ਹੈ।', home_metric_reports: 'ਜਮ੍ਹਾਂ ਕੀਤੀਆਂ ਰਿਪੋਰਟਾਂ', home_metric_lives: 'ਬਚਾਈਆਂ ਜਾਨਾਂ', fp_photo: 'ਫੋਟੋ', fp_details: 'ਵੇਰਵੇ', fp_review: 'ਸਮੀਖਿਆ', fp_send: 'ਭੇਜੋ', my_reports: 'ਮੇਰੀਆਂ ਰਿਪੋਰਟਾਂ' },
};

// ── UNDP April 2026 language pack addenda ─────────────────────────────
// Keys added during the UNDP-alignment sprint for each of the six UN
// locales. Merged into the live I18N dict inside `activateLang` AFTER
// `I18N.en` and AFTER `EXTRA_LANG[code]`, so these values take
// precedence — the older dense packs are not re-written key-by-key.
const UNDP_I18N_EXTRA = {
    fr: {
        minimal_damage: 'Minime', tsunami: 'Tsunami', explosion: 'Explosion',
        chemical_incident: 'Chimique', civil_unrest: 'Troubles civils',
        residential: 'Résidentiel', commercial: 'Commercial', utility: 'Services',
        transport_communication: 'Transport & comm.', community: 'Communauté',
        public_spaces: 'Espaces publics', home_metric_verified: 'Rapports vérifiés',
        building_select_title: 'Optionnel : choisir le bâtiment exact',
        building_select_hint: "Appuyez sur un contour pour le marquer comme endommagé.",
        building_selected: 'Bâtiment sélectionné',
    },
    es: {
        minimal_damage: 'Mínimo', tsunami: 'Tsunami', explosion: 'Explosión',
        chemical_incident: 'Químico', civil_unrest: 'Disturbios civiles',
        residential: 'Residencial', commercial: 'Comercial', utility: 'Servicios',
        transport_communication: 'Transporte y Com.', community: 'Comunidad',
        public_spaces: 'Espacios públicos', home_metric_verified: 'Informes verificados',
        building_select_title: 'Opcional: elegir el edificio exacto',
        building_select_hint: 'Toque un contorno para marcarlo como dañado.',
        building_selected: 'Edificio seleccionado',
    },
    ar: {
        minimal_damage: 'أدنى', tsunami: 'تسونامي', explosion: 'انفجار',
        chemical_incident: 'حادث كيميائي', civil_unrest: 'اضطراب مدني',
        residential: 'سكني', commercial: 'تجاري', utility: 'مرافق',
        transport_communication: 'نقل واتصالات', community: 'مجتمع',
        public_spaces: 'مساحات عامة', home_metric_verified: 'التقارير المُتحقَّقة',
        building_select_title: 'اختياري: اختر المبنى بالضبط',
        building_select_hint: 'اضغط على محيط مبنى لتمييزه كمتضرر.',
        building_selected: 'تم اختيار المبنى',
    },
    ru: {
        minimal_damage: 'Минимальный', tsunami: 'Цунами', explosion: 'Взрыв',
        chemical_incident: 'Химический инцидент', civil_unrest: 'Гражданские беспорядки',
        residential: 'Жилой', commercial: 'Коммерческий', utility: 'Инженерные сети',
        transport_communication: 'Транспорт и связь', community: 'Общественный',
        public_spaces: 'Общественные пространства', home_metric_verified: 'Проверенные отчёты',
        building_select_title: 'Необязательно: укажите точное здание',
        building_select_hint: 'Нажмите на контур здания, чтобы отметить его как повреждённое.',
        building_selected: 'Здание выбрано',
    },
    zh: {
        minimal_damage: '轻微', tsunami: '海啸', explosion: '爆炸',
        chemical_incident: '化学事故', civil_unrest: '社会动乱',
        residential: '住宅', commercial: '商业', utility: '公用设施',
        transport_communication: '交通通信', community: '社区',
        public_spaces: '公共空间', home_metric_verified: '已验证报告',
        building_select_title: '可选：选择具体建筑',
        building_select_hint: '点击建筑轮廓将其标记为损坏。',
        building_selected: '已选择建筑',
    },
    // Urdu, Farsi, Hebrew — RTL locales get the same additions so the
    // text direction flip + new keys ship together.
    ur: {
        minimal_damage: 'کم سے کم', tsunami: 'سونامی', explosion: 'دھماکہ',
        chemical_incident: 'کیمیائی حادثہ', civil_unrest: 'شہری بدامنی',
        residential: 'رہائشی', commercial: 'تجارتی', utility: 'سہولیات',
        transport_communication: 'ٹرانسپورٹ اور مواصلات', community: 'کمیونٹی',
        public_spaces: 'عوامی مقامات', home_metric_verified: 'تصدیق شدہ رپورٹیں',
        building_select_title: 'اختیاری: عین عمارت کا انتخاب',
        building_select_hint: 'نقصان زدہ نشان لگانے کے لیے کسی عمارت کی بیرونی لکیر پر ٹیپ کریں۔',
        building_selected: 'عمارت منتخب',
    },
};

// Expose the locale dicts on window so tests, the dashboard embed shell,
// and future debugging probes can read them without reaching into module
// scope. Top-level `const` bindings in a classic (non-module) script are
// accessible by bare identifier but NOT via `window.<name>` — see the
// locale-JSON loader spec which relied on `window.I18N.fr.loc_resolving`.
// `I18N[code]` is mutated in-place by `activateLang()`, so this single
// window-assignment automatically reflects the merged dense JSON pack
// as it arrives — no need to re-assign on every merge.
window.I18N = I18N;
window.EXTRA_LANG = EXTRA_LANG;
window.UNDP_I18N_EXTRA = UNDP_I18N_EXTRA;

function detectAndSetupLanguage() {
    const langSwitcher = document.getElementById('lang-switcher');
    const localBtn = document.getElementById('btn-lang-local');
    const enBtn = document.getElementById('btn-lang-en');
    const changeBtn = document.getElementById('btn-lang-change');
    // Apr 2026 language-UX rewrite — primary visible control. Always shows
    // the current active locale; click opens the full picker. All legacy
    // buttons (#btn-lang-local / #btn-lang-en / #btn-lang-change) are kept
    // in the DOM hidden for Playwright back-compat.
    const currentBtn = document.getElementById('btn-lang-current');
    const suggestedRow = document.getElementById('lang-picker-suggested');

    // Update the one visible pill to reflect the active locale code.
    function _updateLangSwitcherMode(code) {
        const upper = String(code || 'en').toUpperCase();
        if (currentBtn) {
            currentBtn.textContent = '🌐 ' + upper;
            currentBtn.dataset.lang = code || 'en';
        }
    }

    // UNDP §3.1 April 2026 — RTL-script languages. Flipping the document
    // direction via `<html dir>` cascades to every logical-property style
    // (margin-inline-start, padding-inline-end, text-align: start, etc.)
    // The flow-progress bar, chip rows, and card layouts were written
    // with logical properties where practical, so the mirror is free for
    // those. A handful of hand-positioned elements needed :dir() tweaks
    // in styles.css — see the "RTL" block at the bottom of that file.
    const RTL_LANGS = new Set([
        'ar', 'ur', 'fa', 'he', 'ps', 'ku', 'sd', 'ug', 'yi',
    ]);

    function _applyTextDirection(code) {
        const html = document.documentElement;
        if (!html) return;
        const dir = RTL_LANGS.has(String(code || '').toLowerCase()) ? 'rtl' : 'ltr';
        if (html.dir !== dir) html.dir = dir;
        html.lang = code || 'en';
    }

    function activateLang(code) {
        state.lang = code;
        // Compose the active locale dict: start with EN baseline, layer the
        // dense EXTRA_LANG pack, then layer the April-2026 UNDP addenda on
        // top so the latest UNDP keys always win over any older translation.
        const base = I18N[code] || {};
        const dense = EXTRA_LANG[code] || {};
        const addenda = (typeof UNDP_I18N_EXTRA !== 'undefined' && UNDP_I18N_EXTRA[code]) || {};
        if (EXTRA_LANG[code] || UNDP_I18N_EXTRA[code]) {
            I18N[code] = Object.assign({}, I18N.en, base, dense, addenda);
        }
        applyI18n();
        _applyTextDirection(code);
        const entry = REGION_LANG_MAP.find(r => r.code === code);
        const countryEntry = Object.values(COUNTRY_LANG_DATA).find(e => e.code === code);
        state.speechCode = entry ? entry.speech : (countryEntry ? countryEntry.speech : 'en-IN');
        _updateLangSwitcherMode(code);
        // Also keep legacy buttons' active class in sync for tests.
        if (enBtn)   enBtn.classList.toggle('active', code === 'en');
        if (localBtn) localBtn.classList.toggle('active', code !== 'en' && localBtn.dataset.lang === code);

        // UNDP §3.1b — async upgrade to the dense JSON pack (232 keys).
        // First paint uses the inline pack above (fast, sync). The JSON
        // pack then arrives and re-renders with the richer translations.
        // If the user switches away before the JSON resolves, the .then()
        // still runs but the final applyI18n() is a no-op because
        // state.lang will have moved on — that's fine.
        _loadLocaleJson(code).then((json) => {
            if (!json) return;
            // Only re-merge if the user hasn't switched to another locale
            // in the meantime — otherwise we'd stomp on their new choice.
            if (state.lang !== code) return;
            I18N[code] = Object.assign({}, I18N.en, I18N[code] || {}, json);
            applyI18n();
        }).catch(() => { /* non-fatal — inline pack remains in use */ });
    }

    // Language policy (Apr 2026, revised):
    //   1. User's manual pick (localStorage['crisp_lang_manual']) always wins.
    //   2. Otherwise, auto-activate the detected local language (GPS / IP
    //      geo → REGION_LANG_MAP / COUNTRY_LANG_DATA).
    //   3. Otherwise, fall back to English.
    //
    // This was flipped-then-reverted-once: earlier we defaulted to English
    // and showed the local as a "Your region" suggestion in the picker.
    // User feedback: for most CRISP users (low-literacy, crisis, native
    // speakers of the local language) defaulting to English adds friction.
    // So the app now opens in the detected local by default, but users
    // who picked English (or any other locale) once have their choice
    // remembered across reloads.
    //
    // `state.detectedLang` / `state.detectedLangLabel` are still populated
    // so the picker can show a "Detected: ಕನ್ನಡ" hint row when the user
    // has manually picked something that differs from their region.
    function noteDetectedLocal(code, label) {
        state.detectedLang = code || null;
        state.detectedLangLabel = label || null;
        if (localBtn) {
            localBtn.dataset.lang = code || 'en';
            localBtn.textContent = '🌐 ' + String(code || 'EN').toUpperCase();
            if (label) localBtn.title = label;
        }
        // If the user has no manual pick, promote the detected local to
        // the active locale (default behaviour — local wins).
        const manual = localStorage.getItem('crisp_lang_manual') || '';
        if (!manual && code && code !== state.lang && I18N[code]) {
            activateLang(code);
        }
        // Paint the suggestion chip inside the picker overlay only when
        // it's actionable — user is manually on a different locale AND
        // the detected one is a real supported language. Keeps the picker
        // clean when the user is already on their region's language.
        if (!suggestedRow) return;
        if (!code || code === state.lang || code === manual) {
            suggestedRow.style.display = 'none';
            return;
        }
        suggestedRow.innerHTML =
            '<button class="lang-picker-suggested-btn" data-lang="' + escapeHtmlSimple(code) + '">' +
              '<span>📍 Your region: <strong>' + escapeHtmlSimple(label || code) + '</strong></span>' +
              '<span class="lpf-chevron">›</span>' +
            '</button>';
        suggestedRow.style.display = 'block';
        const btn = suggestedRow.querySelector('button');
        if (btn) btn.addEventListener('click', () => {
            activateLang(code);
            localStorage.setItem('crisp_lang_manual', code);
            _closeLangPicker();
        });
    }

    // Back-compat shim: older code paths call showLocalLangBtn(code, label)
    // to mark the local as active. With the new policy this delegates to
    // noteDetectedLocal which auto-activates the detected lang unless the
    // user has a manual override in localStorage.
    function showLocalLangBtn(code, label) {
        noteDetectedLocal(code, label);
    }

    // Flag-picker overlay. Opens from #btn-lang-current (primary visible
    // control) and optionally from #btn-lang-change (legacy alias). Users
    // can pick any supported language; the choice is remembered in
    // localStorage so the next visit opens in the same language without
    // re-detecting GPS.
    const pickerOverlay = document.getElementById('lang-picker-overlay');
    function _closeLangPicker() {
        if (pickerOverlay) pickerOverlay.style.display = 'none';
    }
    function _openLangPicker() {
        if (pickerOverlay) pickerOverlay.style.display = 'flex';
    }
    if (currentBtn) currentBtn.addEventListener('click', _openLangPicker);
    if (changeBtn) changeBtn.addEventListener('click', _openLangPicker);
    if (pickerOverlay) {
        pickerOverlay.addEventListener('click', (e) => {
            if (e.target === pickerOverlay) _closeLangPicker();
        });
        const closeBtn = document.getElementById('lang-picker-close');
        if (closeBtn) closeBtn.addEventListener('click', _closeLangPicker);
        document.querySelectorAll('#lang-picker-overlay .lang-picker-flag').forEach(flag => {
            flag.addEventListener('click', () => {
                const code = flag.dataset.lang;
                if (!code) return;
                activateLang(code);
                // Remember manual choice so subsequent loads skip the
                // English default and open directly in this locale.
                try { localStorage.setItem('crisp_lang_manual', code); } catch (_) {}
                _closeLangPicker();
            });
        });
    }

    // Back-compat button click handlers. Kept for Playwright specs that
    // interact with #btn-lang-en / #btn-lang-local via `{ force: true }`.
    localBtn.addEventListener('click', () => {
        const code = localBtn.dataset.lang || 'en';
        activateLang(code);
        try { localStorage.setItem('crisp_lang_manual', code); } catch (_) {}
    });
    enBtn.addEventListener('click', () => {
        activateLang('en');
        try { localStorage.setItem('crisp_lang_manual', 'en'); } catch (_) {}
    });

    // ── Restore cached location + language instantly (before any network call) ──
    // (_LOC_CTX_KEY, _saveLocCtx, _patchLocCtx are module-scope — defined near resolveLocationName)

    function _applyLocCtx(ctx) {
        // Restore location state
        state.location     = { lat: ctx.lat, lng: ctx.lng, acc: ctx.acc };
        state.deviceLocation = { lat: ctx.lat, lng: ctx.lng };
        state.locationName = ctx.name || null;
        // Language policy (revised Apr 2026): auto-activate the cached
        // local lang unless the user has a manual override — see
        // noteDetectedLocal for the full policy. When no cache match,
        // the live GPS / IP paths below will call noteDetectedLocal
        // directly once a locale resolves.
        if (ctx.lang && ctx.langLabel) {
            noteDetectedLocal(ctx.lang, ctx.langLabel);
        }
        // Update location display immediately — no "Locating..." shown
        const locCoords = document.getElementById('loc-coords');
        if (locCoords && ctx.name) locCoords.textContent = ctx.name;
        const summaryLoc = document.getElementById('summary-loc');
        if (summaryLoc && ctx.name) summaryLoc.textContent = ctx.name;
    }

    // Apr 2026 language-UX rewrite: start with English by default, then
    // upgrade to the user's manual choice (from localStorage) if present.
    // GPS / IP detection proceeds in the background purely to populate
    // the "Your region" suggestion — never to force-switch the UI.
    const _manualLang = (() => {
        try { return localStorage.getItem('crisp_lang_manual') || ''; } catch (_) { return ''; }
    })();
    // "Known locale" = present in ANY of our locale registries, OR listed
    // as RTL. The inline I18N dict only carries en/kn/hi/ta (our original
    // 4 languages); the UN / India dense packs live in EXTRA_LANG and
    // UNDP_I18N_EXTRA, and Hebrew is RTL-only (no inline dict but the
    // direction flip + async JSON load should still work). Previously
    // this check only consulted I18N, so a user manually picking Arabic /
    // French / Hebrew etc. would silently snap back to English on every
    // reload — bug reproduced by 13-rtl-layout + 14-locale-json-loader.
    const _isKnownLocale = (code) => {
        if (!code || typeof code !== 'string') return false;
        if (I18N[code]) return true;
        if (typeof EXTRA_LANG !== 'undefined' && EXTRA_LANG[code]) return true;
        if (typeof UNDP_I18N_EXTRA !== 'undefined' && UNDP_I18N_EXTRA[code]) return true;
        if (RTL_LANGS.has(code)) return true;
        // COUNTRY_LANG_DATA values are { code, label, speech } — accept
        // any code declared there (e.g. Italian via IT).
        if (typeof COUNTRY_LANG_DATA !== 'undefined') {
            for (const k in COUNTRY_LANG_DATA) {
                if (COUNTRY_LANG_DATA[k] && COUNTRY_LANG_DATA[k].code === code) return true;
            }
        }
        // REGION_LANG_MAP entries are { code, speech, ... }.
        if (typeof REGION_LANG_MAP !== 'undefined' && Array.isArray(REGION_LANG_MAP)) {
            for (const r of REGION_LANG_MAP) {
                if (r && r.code === code) return true;
            }
        }
        return false;
    };
    activateLang(_isKnownLocale(_manualLang) ? _manualLang : 'en');

    const _cachedCtx = (() => {
        try { return JSON.parse(localStorage.getItem(_LOC_CTX_KEY) || 'null'); } catch (_) { return null; }
    })();

    if (_cachedCtx && _cachedCtx.lat) {
        _applyLocCtx(_cachedCtx);
    }

    // Try to get GPS and reverse geocode
    if (!navigator.geolocation) {
        activateLang('en');
        return;
    }

    // On non-HTTPS origins (e.g. http://192.168.x.x:8080 on a real phone)
    // browsers block geolocation. Detect and degrade gracefully.
    const isSecureContext = window.isSecureContext ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1';

    if (!isSecureContext) {
        // Non-HTTPS non-localhost: GPS blocked by browser. Try IP geo for language + coords.
        console.warn('GPS unavailable: non-HTTPS origin. Falling back to IP geolocation.');
        tryIPGeolocation().then(ipLoc => {
            if (ipLoc) {
                state.location = ipLoc;
                state.deviceLocation = { lat: ipLoc.lat, lng: ipLoc.lng };
                const regionStr = (ipLoc.region || '').toLowerCase();
                for (const entry of REGION_LANG_MAP) {
                    if (entry.match.some(k => regionStr.includes(k))) {
                        _saveLocCtx(ipLoc.lat, ipLoc.lng, 5000, state.locationName, entry.code, entry.label, entry.speech);
                        showLocalLangBtn(entry.code, entry.label, entry.speech);
                        return;
                    }
                }
                const cc = (ipLoc.country || '').toUpperCase();
                if (COUNTRY_LANG_DATA[cc]) {
                    const e = COUNTRY_LANG_DATA[cc];
                    _saveLocCtx(ipLoc.lat, ipLoc.lng, 5000, state.locationName, e.code, e.label, e.speech);
                    showLocalLangBtn(e.code, e.label, e.speech);
                    return;
                }
            }
            activateLang('en');
        });
        return;
    }

    // Set a timeout for GPS — 8s is enough for most devices.
    // Don't give up too early (was 4s, GPS needs 5-10s on cold start)
    const gpsTimeout = setTimeout(() => {
        if (!state.location) {
            console.warn('GPS timeout (8s) — trying IP fallback');
            tryIPGeolocation().then(ipLoc => {
                if (ipLoc && !state.location) {
                    state.location = ipLoc;
                    state.deviceLocation = { lat: ipLoc.lat, lng: ipLoc.lng };
                }
                if (!state.lang || state.lang === 'en') activateLang('en');
            });
        }
    }, 8000);

    // Try coarse location first (WiFi/cell, instant), then upgrade to GPS
    navigator.geolocation.getCurrentPosition(async (pos) => {
        clearTimeout(gpsTimeout);
        state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        state.deviceLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        // Cache raw device GPS — restored on new report (not user-corrected location)
        try {
            localStorage.setItem('crisp_device_gps', JSON.stringify({
                lat: pos.coords.latitude, lng: pos.coords.longitude,
                acc: pos.coords.accuracy, ts: Date.now()
            }));
        } catch (_) {}
        console.log('GPS Fixed:', state.location);
        // Pre-fetch nearby places for offline autocomplete (non-blocking background task)
        if (typeof placeSearch !== 'undefined' && navigator.onLine !== false) {
            placeSearch.prefetchNearby(pos.coords.latitude, pos.coords.longitude);
        }
        // Offline-first: no outbound HTTP in the capture flow.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return;
        }
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json&addressdetails=1`,
                { headers: { 'Accept-Language': 'en' } }
            );
            const data = await res.json();
            const addr = data.address || {};

            // Cache the human-readable place name from reverse geocode
            const nameParts = [];
            const local = addr.neighbourhood || addr.suburb || addr.hamlet || addr.village || addr.town || '';
            const city = addr.city || addr.county || addr.state_district || addr.state || '';
            if (local) nameParts.push(local);
            if (city && city !== local) nameParts.push(city);
            if (addr.country) nameParts.push(addr.country);
            state.locationName = nameParts.length > 0 ? nameParts.join(', ') : (data.display_name || null);
            console.log('Location name:', state.locationName);
            const countryCode = (addr.country_code || '').toUpperCase();
            const regionStr = [
                addr.state, addr.state_district, addr.county,
                addr.city, addr.suburb, addr.neighbourhood, addr.country
            ].filter(Boolean).join(' ').toLowerCase();
            for (const entry of REGION_LANG_MAP) {
                if (entry.match.some(keyword => regionStr.includes(keyword))) {
                    _saveLocCtx(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
                        state.locationName, entry.code, entry.label, entry.speech);
                    showLocalLangBtn(entry.code, entry.label, entry.speech);
                    return;
                }
            }
            if (COUNTRY_LANG_DATA[countryCode]) {
                const entry = COUNTRY_LANG_DATA[countryCode];
                _saveLocCtx(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
                    state.locationName, entry.code, entry.label, entry.speech);
                showLocalLangBtn(entry.code, entry.label, entry.speech);
                return;
            }
            const browserLang = navigator.language.split('-')[0];
            const resolvedLang = browserLang !== 'en' ? browserLang : 'en';
            _saveLocCtx(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
                state.locationName, resolvedLang, null, null);
            if (browserLang !== 'en') { activateLang(browserLang); } else { activateLang('en'); }
        } catch {
            activateLang('en');
        }
    }, async (err) => {
        // GPS denied/unavailable — fall back to IP geolocation for coords + language
        clearTimeout(gpsTimeout);
        console.warn('GPS error on startup:', err.code, err.message, '— trying IP geolocation fallback');
        const ipLoc = await tryIPGeolocation();
        if (ipLoc) {
            state.location = ipLoc;
            state.deviceLocation = { lat: ipLoc.lat, lng: ipLoc.lng };
            try {
                localStorage.setItem('crisp_device_gps', JSON.stringify({
                    lat: ipLoc.lat, lng: ipLoc.lng, acc: 5000, ts: Date.now(), is_ip_based: true
                }));
            } catch (_) {}
            resolveLocationName();
            const regionStr = (ipLoc.region || '').toLowerCase();
            for (const entry of REGION_LANG_MAP) {
                if (entry.match.some(k => regionStr.includes(k))) {
                    _saveLocCtx(ipLoc.lat, ipLoc.lng, 5000, state.locationName, entry.code, entry.label, entry.speech);
                    showLocalLangBtn(entry.code, entry.label, entry.speech);
                    return;
                }
            }
            const cc = (ipLoc.country || '').toUpperCase();
            if (COUNTRY_LANG_DATA[cc]) {
                const e = COUNTRY_LANG_DATA[cc];
                _saveLocCtx(ipLoc.lat, ipLoc.lng, 5000, state.locationName, e.code, e.label, e.speech);
                showLocalLangBtn(e.code, e.label, e.speech);
                return;
            }
        }
        activateLang('en');
    }, {
        enableHighAccuracy: false,  // Use WiFi/cell first (instant), not GPS hardware (slow)
        timeout: 8000,
        maximumAge: 60000  // Accept cached position up to 1 minute old (fast startup)
    });

    // After coarse fix, upgrade to high-accuracy GPS in background (non-blocking)
    setTimeout(() => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
                state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
                state.deviceLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                try { localStorage.setItem('crisp_device_gps', JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: Date.now() })); } catch(_){}
                console.log('GPS upgraded to high accuracy:', pos.coords.accuracy, 'm');
            }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
        }
    }, 2000);
}
function setupPhotoStage() {
    const previewImg = document.getElementById('photo-preview');
    const placeholder = document.getElementById('photo-placeholder');
    const nextBtn = document.getElementById('btn-photo-next');
    const helperText = document.getElementById('photo-helper');

    function showPreview(dataUrl) {
        previewImg.src = dataUrl;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
        // Phase 2: once a photo exists, enable Next and hide the helper prompt.
        nextBtn.disabled = false;
        nextBtn.style.display = 'flex';
        if (helperText) helperText.style.display = 'none';
        // PII privacy notice overlay on the photo
        let privNote = previewImg.parentElement.querySelector('.photo-privacy-note');
        if (!privNote) {
            privNote = document.createElement('div');
            privNote.className = 'photo-privacy-note';
            privNote.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Faces will be auto-blurred for privacy';
            previewImg.parentElement.appendChild(privNote);
        }
        // Show "Add more photos" strip after first photo
        const strip = document.getElementById('extra-photos-strip');
        if (strip) strip.style.display = 'flex';
        _updateExtraPhotoStrip();
    }

    function _updateExtraPhotoStrip() {
        const scroll = document.getElementById('extra-photos-scroll');
        if (!scroll) return;
        scroll.innerHTML = '';
        // Primary photo — first thumb, ❌ in bottom-left, tap opens viewer.
        if (state.photoDataUrl) {
            const thumb = document.createElement('div');
            thumb.className = 'extra-photo-thumb active';
            thumb.innerHTML = `<img src="${state.photoDataUrl}" alt="">`
                + `<button class="extra-photo-remove" type="button" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>`;
            // Tap thumb (not the ❌) → previews inline AND opens full-screen viewer.
            thumb.addEventListener('click', (ev) => {
                if (ev.target.closest('.extra-photo-remove')) return;  // let ❌ handle it
                previewImg.src = state.photoDataUrl;
                document.querySelectorAll('.extra-photo-thumb').forEach(t => t.classList.remove('active'));
                thumb.classList.add('active');
                _openImageViewer(state.photoDataUrl, { kind: 'primary' });
            });
            // ❌ deletes the primary photo immediately. Clears state.photoDataUrl
            // + promotes the first extra to primary if any exist, so the flow
            // still has a capture (photo is mandatory). If no extras remain,
            // returns the user to the empty-state capture screen.
            thumb.querySelector('.extra-photo-remove').addEventListener('click', (ev) => {
                ev.stopPropagation();
                _deletePrimaryPhoto();
            });
            scroll.appendChild(thumb);
        }
        // Extra photos — ❌ in bottom-left, tap opens viewer.
        state.extraPhotos.forEach((ep, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'extra-photo-thumb';
            thumb.innerHTML = `<img src="${ep.dataUrl}" alt="">`
                + `<button class="extra-photo-remove" type="button" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>`;
            thumb.addEventListener('click', (ev) => {
                if (ev.target.closest('.extra-photo-remove')) return;
                previewImg.src = ep.dataUrl;
                document.querySelectorAll('.extra-photo-thumb').forEach(t => t.classList.remove('active'));
                thumb.classList.add('active');
                _openImageViewer(ep.dataUrl, { kind: 'extra', index: idx });
            });
            thumb.querySelector('.extra-photo-remove').addEventListener('click', (ev) => {
                ev.stopPropagation();
                window.removeExtraPhoto(idx);
            });
            scroll.appendChild(thumb);
        });
    }

    window.removeExtraPhoto = (idx) => {
        state.extraPhotos.splice(idx, 1);
        _updateExtraPhotoStrip();
    };

    // Deleting the primary is a bit special — if the user has extras, the
    // first extra is promoted so the capture flow still has something (photo
    // is mandatory downstream). If no extras, we reset the primary to the
    // empty-state so the user can re-capture.
    function _deletePrimaryPhoto() {
        if (state.extraPhotos.length > 0) {
            const firstExtra = state.extraPhotos.shift();
            state.photoDataUrl = firstExtra.dataUrl;
            state.photoBlob = firstExtra.blob;
            state.photoGroupId = firstExtra.groupId;
            state.photoVariants = firstExtra.variants || null;
            previewImg.src = state.photoDataUrl;
        } else {
            state.photoDataUrl = null;
            state.photoBlob = null;
            state.photoGroupId = null;
            state.photoVariants = null;
            previewImg.style.display = 'none';
            previewImg.src = '';
            placeholder.style.display = 'flex';
            nextBtn.disabled = true;
            nextBtn.style.display = 'none';
            if (helperText) helperText.style.display = 'block';
            // Collapse the extras strip since primary is gone.
            const strip = document.getElementById('extra-photos-strip');
            if (strip) strip.style.display = 'none';
        }
        _updateExtraPhotoStrip();
    }

    // Full-screen image viewer. Shows the tapped image + a Delete button
    // that opens a confirmation dialog. The viewer state (`_viewerContext`)
    // is a plain module var so the confirm dialog knows WHAT to delete
    // (primary vs extra[idx]) when the user taps Delete.
    let _viewerContext = null;
    function _openImageViewer(src, context) {
        _viewerContext = context || null;
        const overlay = document.getElementById('image-viewer-overlay');
        const img = document.getElementById('image-viewer-img');
        if (!overlay || !img) return;
        img.src = src;
        overlay.style.display = 'flex';
    }
    function _closeImageViewer() {
        _viewerContext = null;
        const overlay = document.getElementById('image-viewer-overlay');
        const img = document.getElementById('image-viewer-img');
        if (overlay) overlay.style.display = 'none';
        if (img) img.src = '';
    }
    // Expose for setup below (wires click handlers once per stage init).
    this._openImageViewer = _openImageViewer;
    window.__crispOpenImageViewer = _openImageViewer;
    window.__crispCloseImageViewer = _closeImageViewer;
    window.__crispViewerContext = () => _viewerContext;
    window.__crispDeletePrimaryPhoto = _deletePrimaryPhoto;
    // PR 5 (Apr 2026): camera modal's "Done" button needs a refresh hook so
    // snaps taken inside the modal appear in the stage-photo extras strip.
    window.__crispRefreshPhotoStrip = () => {
        const strip = document.getElementById('extra-photos-strip');
        if (strip && state.photoDataUrl) strip.style.display = 'flex';
        _updateExtraPhotoStrip();
    };

    // "Add more photos" button
    const addMoreBtn = document.getElementById('btn-add-more-photo');
    const fileExtra = document.getElementById('file-extra');
    if (addMoreBtn && fileExtra) {
        addMoreBtn.addEventListener('click', () => fileExtra.click());
        fileExtra.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    detectPWANetworkTier();
                    const nc = getPWAAdaptiveConfig();
                    const canvas = document.createElement('canvas');
                    let cw = img.width, ch = img.height;
                    if (Math.max(cw, ch) > nc.imageMaxWidth) { const s = nc.imageMaxWidth / Math.max(cw, ch); cw = Math.round(cw * s); ch = Math.round(ch * s); }
                    canvas.width = cw; canvas.height = ch;
                    canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
                    const dataUrl = canvas.toDataURL('image/jpeg', nc.imageQuality);
                    canvas.toBlob((rawBlob) => {
                        // Placeholder entry up front so the UI strip updates; each extra
                        // photo gets its own photoGroupId + 3 variants built async.
                        const entry = { dataUrl, blob: rawBlob, groupId: genUUID(), variants: null };
                        state.extraPhotos.push(entry);
                        _updateExtraPhotoStrip();
                        // Defer blur+variants via _runWhenIdle so the UI can
                        // paint + handle taps before the TF.js face detector
                        // saturates the main thread. See _runWhenIdle doc.
                        _trackBlur(_runWhenIdle(async () => {
                            const variants = window.ImageVariants
                                ? await window.ImageVariants.generate(rawBlob).catch(e => {
                                    _silent('imageVariants.extra', e);
                                    return null;
                                })
                                : null;
                            if (variants) {
                                entry.variants = variants;
                                entry.blob = variants.small.blob;
                                entry.clientBlurApplied = Boolean(variants.clientBlurApplied);
                                try {
                                    entry.dataUrl = await _blobToDataUrl(variants.small.blob);
                                    _updateExtraPhotoStrip();
                                } catch (_) {}
                            } else {
                                // Variant generation failed — fall back to single-blur upload.
                                const br = await _blurIfPossible(rawBlob);
                                entry.blob = br.blob;
                                entry.clientBlurApplied = br.blurred;
                                if (br.blob !== rawBlob) {
                                    try {
                                        entry.dataUrl = await _blobToDataUrl(br.blob);
                                        _updateExtraPhotoStrip();
                                    } catch (_) {}
                                }
                            }
                        }));
                    }, 'image/jpeg', nc.imageQuality);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
            fileExtra.value = '';
        });
    }

    // Camera button
    document.getElementById('btn-open-camera').addEventListener('click', () => {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS || !navigator.mediaDevices?.getUserMedia) {
            // Fallback to native camera on iOS
            document.getElementById('file-camera').click();
        } else {
            openCameraModal();
        }
    });

    // Browse button
    document.getElementById('btn-browse-photo').addEventListener('click', () => {
        document.getElementById('file-browse').click();
    });

    // PR 5 (Apr 2026): shared ingest pipeline for File objects — camera-fallback
    // AND browse (both single + multi-select). `asExtra=true` appends into
    // state.extraPhotos; `asExtra=false` fills the primary photo slot. The
    // caller decides routing once, synchronously, based on whether the primary
    // slot is already populated.
    function _ingestFileAsPhoto(file, { asExtra = false } = {}) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                detectPWANetworkTier();
                const netCfg = getPWAAdaptiveConfig();
                const maxDim = netCfg.imageMaxWidth;
                const quality = netCfg.imageQuality;

                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
                    else { w = Math.round(w * maxDim / h); h = maxDim; }
                }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);

                if (!asExtra) {
                    state.photoDataUrl = dataUrl;
                    showPreview(dataUrl);
                }

                canvas.toBlob((rawBlob) => {
                    if (asExtra) {
                        const entry = { dataUrl, blob: rawBlob, groupId: genUUID(), variants: null };
                        state.extraPhotos.push(entry);
                        _updateExtraPhotoStrip();
                        // Defer blur+variants via _runWhenIdle so the UI can
                        // paint + handle taps before TF.js saturates the main
                        // thread. See _runWhenIdle doc.
                        _trackBlur(_runWhenIdle(async () => {
                            const variants = window.ImageVariants
                                ? await window.ImageVariants.generate(rawBlob).catch(e => { _silent('imageVariants.extraFile', e); return null; })
                                : null;
                            if (variants) {
                                entry.variants = variants;
                                entry.blob = variants.small.blob;
                                entry.clientBlurApplied = Boolean(variants.clientBlurApplied);
                                try { entry.dataUrl = await _blobToDataUrl(variants.small.blob); _updateExtraPhotoStrip(); } catch (_) {}
                            } else {
                                const br = await _blurIfPossible(rawBlob);
                                entry.blob = br.blob;
                                entry.clientBlurApplied = br.blurred;
                                if (br.blob !== rawBlob) {
                                    try { entry.dataUrl = await _blobToDataUrl(br.blob); _updateExtraPhotoStrip(); } catch (_) {}
                                }
                            }
                        }));
                        return;
                    }
                    // Primary-photo path.
                    state.photoBlob = rawBlob;
                    state.photoGroupId = genUUID();
                    _trackBlur(_runWhenIdle(async () => {
                        const variants = window.ImageVariants
                            ? await window.ImageVariants.generate(rawBlob).catch(e => { _silent('imageVariants.file', e); return null; })
                            : null;
                        if (variants) {
                            state.photoVariants = variants;
                            state.photoBlob = variants.small.blob;
                            state.photoClientBlurApplied = Boolean(variants.clientBlurApplied);
                            try {
                                const smallUrl = await _blobToDataUrl(variants.small.blob);
                                state.photoDataUrl = smallUrl;
                                showPreview(smallUrl);
                            } catch (_) {}
                        } else {
                            const br = await _blurIfPossible(rawBlob);
                            state.photoBlob = br.blob;
                            state.photoClientBlurApplied = br.blurred;
                            if (br.blob !== rawBlob) {
                                try {
                                    const blurredUrl = await _blobToDataUrl(br.blob);
                                    state.photoDataUrl = blurredUrl;
                                    showPreview(blurredUrl);
                                } catch (_) {}
                            }
                        }
                    })());
                }, 'image/jpeg', quality);
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    }
    // Expose for the camera modal (which needs to push snapshots as extras
    // without going through the hidden file input).
    window.__crispIngestFile = _ingestFileAsPhoto;

    // File input handlers.
    //   file-camera — single-file (iOS native camera, one shot per invocation)
    //   file-browse — PR 5: multi-select; first file fills primary slot if
    //                 empty, rest go to extras. Route decided synchronously
    //                 so async FileReader can't misorder the decision.
    ['file-camera', 'file-browse'].forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length === 0) return;
            const startedWithPrimary = !!state.photoDataUrl;
            files.forEach((file, i) => {
                const asExtra = startedWithPrimary || i > 0;
                _ingestFileAsPhoto(file, { asExtra });
            });
            e.target.value = '';
        });
    });

    // Phase 2: photo is now mandatory — skip link removed; Next is gated on
    // having a photo. The disabled attribute set in index.html keeps the button
    // unclickable until showPreview() flips it to enabled on first capture.
    nextBtn.addEventListener('click', () => {
        if (!state.photoDataUrl) {
            // Defensive — button is disabled but in case CSS is fighting us.
            if (typeof showToast === 'function') showToast(t('photo_required'));
            return;
        }
        goToStage('stage-audio');
    });
}

// ── Camera modal ───────────────────────────────────────────────────────────────
function openCameraModal() {
    const modal = document.getElementById('camera-modal');
    modal.style.display = 'flex';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then(stream => {
            state.cameraStream = stream;
            document.getElementById('camera-stream').srcObject = stream;
        })
        .catch((err) => {
            modal.style.display = 'none';
            // Show friendly message then fall back to file picker
            const msg = err.name === 'NotAllowedError'
                ? 'Camera access blocked — using file picker instead. Allow camera in browser settings for live capture.'
                : 'Camera unavailable — using file picker instead.';
            if (typeof showToast === 'function') showToast(msg);
            else alert(msg);
            document.getElementById('file-camera').click();
        });
}

// Close the camera modal, tearing down the active stream. Shared between the
// X (cancel) button and the Done (confirm) button — same teardown, different
// semantics on what's already been stashed in state.
function _closeCameraModal() {
    if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(t => t.stop());
        state.cameraStream = null;
    }
    const modal = document.getElementById('camera-modal');
    if (modal) modal.style.display = 'none';
    // Reset the mini-gallery for the next invocation.
    const gallery = document.getElementById('cam-gallery');
    const scroll = document.getElementById('cam-gallery-scroll');
    const count = document.getElementById('cam-gallery-count');
    const doneBtn = document.getElementById('btn-cam-done');
    if (gallery) gallery.style.display = 'none';
    if (scroll) scroll.innerHTML = '';
    if (count) count.textContent = '0';
    if (doneBtn) doneBtn.disabled = true;
}

// PR 5 (Apr 2026): camera modal now supports multi-snap. Each tap of the
// shutter captures a frame WITHOUT tearing down the stream so the user can
// keep shooting. First snap → primary photo; subsequent → state.extraPhotos
// (same shape the "Add more photos" file-extra path uses).
//
// The "Done" button confirms + closes; "X" cancels + closes (but in-progress
// state stays — aborting the modal never un-captures work the user did).
// An internal snap counter drives the Done-enabled toggle and the mini-gallery
// badge count.
function setupCameraModal() {
    document.getElementById('btn-cam-close').addEventListener('click', () => {
        _closeCameraModal();
    });
    document.getElementById('btn-cam-done').addEventListener('click', () => {
        _closeCameraModal();
        // Refresh the stage-photo extras strip so the user sees all snaps
        // without leaving the camera. The strip update reads state.extraPhotos
        // which was written synchronously in the snap handler below.
        if (typeof window.__crispRefreshPhotoStrip === 'function') {
            window.__crispRefreshPhotoStrip();
        }
    });

    document.getElementById('btn-cam-snap').addEventListener('click', () => {
        const video = document.getElementById('camera-stream');
        const canvas = document.getElementById('camera-canvas');
        if (!video || !video.videoWidth || !state.cameraStream) return; // stream not ready

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        detectPWANetworkTier();
        const camCfg = getPWAAdaptiveConfig();
        const dataUrl = canvas.toDataURL('image/jpeg', camCfg.imageQuality);

        // Decide routing synchronously: first snap fills primary; rest become
        // extras. This mirrors the browse-multi-select logic exactly.
        const asExtra = !!state.photoDataUrl;

        if (!asExtra) {
            state.photoDataUrl = dataUrl;
            document.getElementById('photo-preview').src = dataUrl;
            document.getElementById('photo-preview').style.display = 'block';
            document.getElementById('photo-placeholder').style.display = 'none';
            const _nextBtn = document.getElementById('btn-photo-next');
            _nextBtn.disabled = false;
            _nextBtn.style.display = 'flex';
            const _helper = document.getElementById('photo-helper');
            if (_helper) _helper.style.display = 'none';
        }

        // Update the mini-gallery inside the modal immediately — feedback that
        // the snap landed. Primary and extras both appear here; the primary is
        // marked with a green border.
        const gallery = document.getElementById('cam-gallery');
        const scroll = document.getElementById('cam-gallery-scroll');
        const count = document.getElementById('cam-gallery-count');
        const doneBtn = document.getElementById('btn-cam-done');
        if (gallery && scroll && count) {
            if (gallery.style.display !== 'flex') gallery.style.display = 'flex';
            const thumb = document.createElement('div');
            thumb.className = 'cam-gallery-thumb' + (!asExtra ? ' primary' : '');
            thumb.innerHTML = `<img src="${dataUrl}" alt="snap">`;
            scroll.appendChild(thumb);
            scroll.scrollLeft = scroll.scrollWidth;
            // extraPhotos hasn't been pushed yet for asExtra; add 1 in that
            // case so the badge reflects the snap that just landed.
            const total = (state.photoDataUrl ? 1 : 0) + state.extraPhotos.length + (asExtra ? 1 : 0);
            count.textContent = String(total);
        }
        if (doneBtn) doneBtn.disabled = false;

        canvas.toBlob((rawBlob) => {
            state.photoGroupId = state.photoGroupId || genUUID();
            if (asExtra) {
                const entry = { dataUrl, blob: rawBlob, groupId: genUUID(), variants: null };
                state.extraPhotos.push(entry);
                // Bump the modal counter now that the extra has landed.
                const count2 = document.getElementById('cam-gallery-count');
                if (count2) {
                    const total = (state.photoDataUrl ? 1 : 0) + state.extraPhotos.length;
                    count2.textContent = String(total);
                }
                // Defer via _runWhenIdle: camera-modal snaps fire rapid-fire
                // from the shutter, and BlazeFace-per-snap kills the shutter
                // button's responsiveness. Idle-scheduling keeps the UI hot.
                _trackBlur(_runWhenIdle(async () => {
                    const variants = window.ImageVariants
                        ? await window.ImageVariants.generate(rawBlob).catch(e => { _silent('imageVariants.camExtra', e); return null; })
                        : null;
                    if (variants) {
                        entry.variants = variants;
                        entry.blob = variants.small.blob;
                        entry.clientBlurApplied = Boolean(variants.clientBlurApplied);
                        try { entry.dataUrl = await _blobToDataUrl(variants.small.blob); } catch (_) {}
                    } else {
                        const br = await _blurIfPossible(rawBlob);
                        entry.blob = br.blob;
                        entry.clientBlurApplied = br.blurred;
                        if (br.blob !== rawBlob) {
                            try { entry.dataUrl = await _blobToDataUrl(br.blob); } catch (_) {}
                        }
                    }
                }));
                return;
            }
            // Primary slot.
            state.photoBlob = rawBlob;
            // Defer via _runWhenIdle so the user can tap Next / shutter / any
            // UI element without waiting for BlazeFace to finish.
            _trackBlur(_runWhenIdle(async () => {
                const variants = window.ImageVariants
                    ? await window.ImageVariants.generate(rawBlob).catch(e => { _silent('imageVariants.live', e); return null; })
                    : null;
                if (variants) {
                    state.photoVariants = variants;
                    state.photoClientBlurApplied = Boolean(variants.clientBlurApplied);
                    try {
                        const smallUrl = await _blobToDataUrl(variants.small.blob);
                        state.photoDataUrl = smallUrl;
                        document.getElementById('photo-preview').src = smallUrl;
                    } catch (_) {}
                    state.photoBlob = variants.small.blob;
                } else {
                    const br = await _blurIfPossible(rawBlob);
                    state.photoBlob = br.blob;
                    state.photoClientBlurApplied = br.blurred;
                    if (br.blob !== rawBlob) {
                        try {
                            const blurredUrl = await _blobToDataUrl(br.blob);
                            state.photoDataUrl = blurredUrl;
                            document.getElementById('photo-preview').src = blurredUrl;
                        } catch (_) {}
                    }
                }
            })());
        }, 'image/jpeg', camCfg.imageQuality);
    });
}

// ── Client-side PII blur helpers ─────────────────────────────────────────────
// All three capture paths call these; they never throw — on any failure the
// original blob comes back so the pipeline continues. The backend still runs
// its own full PII pass as the safety net.
//
// Apr 2026 — `_blurIfPossible` now returns the truthful result object so the
// upload pipeline can set `client_blur_applied` accurately. Before this fix
// every upload hardcoded `client_blur_applied: true`, so a silent BlazeFace
// failure (CDN blocked, paint crash, etc.) would let unblurred PII slide past
// BOTH the client AND the server (which skipped its own blur trusting the
// flag). Shape: `{ blob, blurred, facesDetected, skipped, error? }`.

async function _blurIfPossible(rawBlob) {
    if (!rawBlob) return { blob: rawBlob, blurred: false, facesDetected: 0, skipped: true, error: 'empty blob' };
    if (typeof window.PIIBlur === 'undefined') {
        return { blob: rawBlob, blurred: false, facesDetected: 0, skipped: true, error: 'PIIBlur not loaded' };
    }
    try {
        const result = await window.PIIBlur.blurFaces(rawBlob);
        // Old PIIBlur returned a raw Blob — back-compat for any cached build.
        if (result instanceof Blob) {
            return { blob: result, blurred: false, facesDetected: 0, skipped: true, error: 'legacy PIIBlur shape' };
        }
        return result || { blob: rawBlob, blurred: false, facesDetected: 0, skipped: true, error: 'null result' };
    } catch (e) {
        console.warn('[PWA] client blur skipped:', e);
        return { blob: rawBlob, blurred: false, facesDetected: 0, skipped: true, error: (e && e.message) || String(e) };
    }
}

// Phase 1: non-blocking blur. The three capture paths call _blurIfPossible()
// asynchronously and don't block the UI — but if the user submits very fast we
// need the enqueue step to wait for the in-flight blur before reading
// state.photoBlob. Each capture site tracks its wrapping promise here; the
// submit path awaits them all before constructing the queued item.
//
// PR 5 (Apr 2026): upgraded from single-slot promise to an array. Multi-snap
// in the camera modal and multi-file browse both fire many blur promises in
// parallel; the old single-slot code let later captures clobber earlier ones
// so awaitPendingBlur() would skip them. _trackBlur pushes; awaitPendingBlur
// waits on every promise still in flight, then clears the array.
state.photoBlurPending = [];
function _trackBlur(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    if (!Array.isArray(state.photoBlurPending)) state.photoBlurPending = [];
    state.photoBlurPending.push(promise);
    return promise;
}

// Apr 2026: field-reported UX bug — the Next button on stage-photo and the
// "Done" button inside the camera modal felt "sticky" for 300–800 ms after
// a capture. Root cause: the code enabled Next synchronously in showPreview()
// but IMMEDIATELY afterwards kicked off the blur+variants pipeline
// (`ImageVariants.generate` → BlazeFace inference → canvas resize × 2) on
// the SAME main thread. The button was technically clickable, but the tap
// event queued behind ~400 ms of TF.js work.
//
// Fix: schedule the heavy async work via requestIdleCallback so the browser
// flushes paint + input handlers first. User-initiated taps pre-empt idle
// callbacks, so "capture → tap Next" feels instant even when the pipeline
// is still churning. On Safari (no rIC) we fall back to a short setTimeout
// which at least lets the current paint complete. The pipeline itself is
// unchanged — same variants, same blur, same `awaitPendingBlur()` gate at
// submit time. Only WHEN it starts moves from "immediately" to "after the
// next idle tick".
function _runWhenIdle(asyncFn) {
    return new Promise((resolve, reject) => {
        const run = () => {
            try { Promise.resolve(asyncFn()).then(resolve, reject); }
            catch (e) { reject(e); }
        };
        if (typeof requestIdleCallback === 'function') {
            // `timeout` guarantees the work doesn't starve forever if the
            // user keeps the thread busy (e.g. scrolling). 200 ms matches
            // the human-perceivable latency budget for UI feedback.
            requestIdleCallback(run, { timeout: 200 });
        } else {
            setTimeout(run, 50);
        }
    });
}
async function awaitPendingBlur() {
    const pending = state.photoBlurPending;
    if (!pending) return;
    // Back-compat: if an older code path assigned a bare promise, await it.
    if (!Array.isArray(pending)) {
        try { await pending; } catch (_) { /* raw blob is fine */ }
        return;
    }
    if (pending.length === 0) return;
    try { await Promise.all(pending); } catch (_) { /* raw blob is fine */ }
    state.photoBlurPending = [];
}

function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
}

/**
 * Inverse of `_blobToDataUrl` — decode a `data:image/jpeg;base64,...`
 * URL into a Blob without going through intermediate strings.
 *
 * Used by the UNDP §5 binary chunk path (`_uploadVariantTier`): the
 * variant is persisted as a data URL in IndexedDB for crash recovery
 * (JSON-serialisable), but uploaded as raw bytes via multipart. This
 * helper bridges the two representations at upload time.
 *
 * Falls through with a zero-byte Blob if the input is malformed —
 * the caller's retry loop will surface an obvious failure rather
 * than throwing here.
 */
function _dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string') return new Blob();
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx < 0) return new Blob();
    const header = dataUrl.substring(0, commaIdx);   // "data:image/jpeg;base64"
    const body   = dataUrl.substring(commaIdx + 1);
    const mimeMatch = header.match(/^data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const isBase64 = /;base64/i.test(header);
    let bytes;
    if (isBase64) {
        try {
            const binStr = atob(body);
            bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        } catch (e) {
            console.warn('[dataUrlToBlob] atob failed:', e);
            return new Blob();
        }
    } else {
        // Percent-encoded body — decode to UTF-8 bytes.
        try {
            bytes = new TextEncoder().encode(decodeURIComponent(body));
        } catch (_) {
            return new Blob();
        }
    }
    return new Blob([bytes], { type: mime });
}

// ── STAGE 2: Audio record + typed description ────────────────────────────────
// Phase 5: Web Speech API (live transcript) removed for parity with RN. Audio
// is still recorded and shipped to the server where Whisper transcribes it.
// The textarea below is purely for typed descriptions.
function setupAudioStage() {
    const micBtn = document.getElementById('btn-mic');
    const micLabel = document.getElementById('mic-label');
    const micIcon = document.getElementById('mic-icon');
    const liveTranscript = document.getElementById('live-transcript');
    const labelText = document.getElementById('transcript-label-text');
    const recTimer = document.getElementById('rec-timer');
    const timerText = document.getElementById('timer-text');
    const nextBtn = document.getElementById('btn-audio-next');
    // Apr 2026 PR 4: `#audio-skip-link` ("Type instead") removed from DOM.
    // The textarea and mic coexist — users type without any toggle.

    // Keep state.transcript synced with manual edits
    liveTranscript.addEventListener('input', () => {
        state.transcript = liveTranscript.value;
    });

    // ── Universal Recording Logic (MediaRecorder) ──
    async function startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.mediaRecorder = new MediaRecorder(stream);
            state.audioChunks = [];
            state.mediaRecorder.ondataavailable = (e) => state.audioChunks.push(e.data);
            state.mediaRecorder.onstop = () => {
                state.audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
            };
            state.mediaRecorder.start();

            state.isRecording = true;
            micBtn.classList.add('recording');
            micIcon.className = 'fa-solid fa-stop';
            micLabel.textContent = t('recording_tap_stop');
            if (labelText) labelText.textContent = t('recording_in_progress');

            recTimer.style.display = 'flex';
            state.timerSeconds = 0;
            timerText.textContent = '00:00';
            state.timerInterval = setInterval(() => {
                state.timerSeconds++;
                const m = String(Math.floor(state.timerSeconds / 60)).padStart(2, '0');
                const s = String(state.timerSeconds % 60).padStart(2, '0');
                timerText.textContent = `${m}:${s}`;
            }, 1000);
        } catch (err) {
            console.error("Mic error:", err);
            alert("Please allow microphone access to record audio.");
        }
    }

    function stopRecording() {
        state.isRecording = false;
        micBtn.classList.remove('recording');
        micIcon.className = 'fa-solid fa-microphone';
        micLabel.textContent = t('tap_mic');
        recTimer.style.display = 'none';
        clearInterval(state.timerInterval);
        if (labelText) labelText.textContent = t('recording_done');

        if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            state.mediaRecorder.stop();
        }

        // Focus the textarea so user can edit immediately
        liveTranscript.focus();

        if (state.transcript && state.transcript.trim()) {
            nextBtn.classList.add('highlight');
        }
    }

    micBtn.addEventListener('click', () => {
        if (!state.isRecording) startRecording();
        else stopRecording();
    });

    function proceedToReview() {
        if (state.isRecording) stopRecording();
        // Small delay to let final speech results arrive
        setTimeout(() => {
            state.transcript = liveTranscript.value;
            goToStage('stage-review');
            populateReview();
        }, 300);
    }

    nextBtn.addEventListener('click', proceedToReview);
}

// ── STAGE 3: Review & Edit ─────────────────────────────────────────────────────
function populateReview() {
    const photoRow = document.getElementById('review-photo-row');
    const photoThumb = document.getElementById('review-photo-thumb');
    if (state.photoDataUrl) {
        photoThumb.src = state.photoDataUrl;
        photoRow.style.display = 'flex';
    } else {
        photoRow.style.display = 'none';
    }

    const editText = document.getElementById('edit-text');
    editText.value = state.transcript || '';

    // Update location UI — show place names, not coordinates
    const locStatus = document.getElementById('loc-status');
    const locCoords = document.getElementById('loc-coords');
    if (state.location && (state.location.lat !== 0 || state.location.lng !== 0)) {
        if (state.location.is_ip_based) {
            locStatus.textContent = t('loc_approximate');
            locStatus.style.color = 'var(--accent, #f59e0b)';
        } else {
            locStatus.textContent = t('loc_detected');
            locStatus.style.color = 'var(--green)';
        }
        // Show resolved place name, or "Resolving..." while we fetch it
        if (state.locationName) {
            locCoords.textContent = state.locationName;
        } else {
            locCoords.textContent = t('loc_resolving');
            resolveLocationName(); // async — will update UI when done
        }
    } else {
        locStatus.textContent = t('loc_type_below');
        locStatus.style.color = 'var(--muted)';
        locCoords.textContent = t('loc_will_find');
    }

    // Sync the selected-place pill with state (replaces old loc-user-name)
    const selPill = document.getElementById('loc-selected-pill');
    const selText = document.getElementById('loc-selected-text');
    if (state.userLocationName) {
        if (selPill && selText) { selText.textContent = state.userLocationName; selPill.style.display = 'flex'; }
        locCoords.textContent = state.userLocationName;
    } else {
        if (selPill) selPill.style.display = 'none';
    }
}

async function refreshLocation() {
    const btn = document.getElementById('btn-refresh-loc');
    const locStatus = document.getElementById('loc-status');
    const locCoords = document.getElementById('loc-coords');

    btn.classList.add('spinning');
    locStatus.textContent = '🛰 Detecting GPS...';
    locStatus.style.color = 'var(--muted)';
    locCoords.textContent = '';

    // Check if GPS is possible in this context
    const canUseGPS = navigator.geolocation && (
        window.isSecureContext ||
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    );

    if (canUseGPS) {
        // Try GPS with a reasonable timeout
        const gpsResult = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 12000);
            navigator.geolocation.getCurrentPosition(
                (pos) => { clearTimeout(timer); resolve(pos); },
                (err) => { clearTimeout(timer); console.warn('GPS refresh error:', err.code, err.message); resolve(null); },
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
            );
        });

        if (gpsResult) {
            state.location = { lat: gpsResult.coords.latitude, lng: gpsResult.coords.longitude, acc: gpsResult.coords.accuracy };
            state.deviceLocation = { lat: gpsResult.coords.latitude, lng: gpsResult.coords.longitude };
            btn.classList.remove('spinning');
            populateReview();
            return;
        }
        // GPS failed — fall through to IP fallback
        locStatus.textContent = '⚡ GPS unavailable, trying network location...';
    }

    // IP-based geolocation fallback
    locStatus.textContent = t('loc_getting');
    const ipLoc = await tryIPGeolocation();
    btn.classList.remove('spinning');

    if (ipLoc) {
        state.location = ipLoc;
        state.deviceLocation = { lat: ipLoc.lat, lng: ipLoc.lng };
        populateReview();
    } else {
        // Both GPS and IP geo failed — show helpful message, don't block
        locStatus.textContent = t('loc_unavailable');
        locStatus.style.color = 'var(--red)';
        locCoords.textContent = 'Search a place name below to set location manually';
    }
}

function setupLocationAutocomplete() {
    const input = document.getElementById('input-loc-search');
    const suggestionsBox = document.getElementById('place-suggestions');
    const clearBtn = document.getElementById('btn-clear-loc');
    const selectedPill = document.getElementById('loc-selected-pill');
    const selectedText = document.getElementById('loc-selected-text');
    const changeBtn = document.getElementById('btn-loc-change');
    if (!input || !suggestionsBox) return;

    // ── Critical: move suggestions box to <body> so it escapes the
    // .stage transform (transform creates a containing block that traps
    // position:fixed children AND clips them with overflow-y:auto) ────────────
    document.body.appendChild(suggestionsBox);

    let activeSuggestions = [];
    let activeIdx = -1;
    let remoteDebounce = null;

    // ── Smart positioning: flip above when not enough space below ─────────────
    function positionDropdown() {
        const rect = input.getBoundingClientRect();
        const vH = window.innerHeight;
        const GAP = 6;
        const spaceBelow = vH - rect.bottom - GAP;
        const spaceAbove = rect.top - GAP;

        // Max height = available space, capped at 5 items × ~60px + small buffer
        const maxVisible = 5;
        const idealH = Math.min(maxVisible * 62, activeSuggestions.length * 62 + (activeSuggestions.length ? 0 : 56));

        suggestionsBox.style.left = rect.left + 'px';
        suggestionsBox.style.width = rect.width + 'px';

        const openBelow = spaceBelow >= 160 || spaceBelow >= spaceAbove;
        if (openBelow) {
            suggestionsBox.style.top = (rect.bottom + GAP) + 'px';
            suggestionsBox.style.bottom = 'auto';
            suggestionsBox.style.maxHeight = Math.max(spaceBelow, 120) + 'px';
            suggestionsBox.classList.remove('opens-up');
            suggestionsBox.classList.add('opens-down');
        } else {
            // Flip above input
            suggestionsBox.style.bottom = (vH - rect.top + GAP) + 'px';
            suggestionsBox.style.top = 'auto';
            suggestionsBox.style.maxHeight = Math.max(spaceAbove, 120) + 'px';
            suggestionsBox.classList.remove('opens-down');
            suggestionsBox.classList.add('opens-up');
        }
    }

    function showSuggestions(places, queryActive) {
        activeSuggestions = places;
        activeIdx = -1;
        positionDropdown();

        if (!places.length) {
            if (queryActive) {
                suggestionsBox.innerHTML = `<div class="place-no-results"><i class="fa-solid fa-magnifying-glass"></i> ${t('place_no_results')}</div>`;
                suggestionsBox.style.display = 'block';
            } else {
                suggestionsBox.style.display = 'none';
            }
            return;
        }

        suggestionsBox.innerHTML = places.slice(0, 5).map((p, i) => {
            const sub = [p.region, p.country].filter(Boolean).join(', ');
            return `<div class="place-item" data-idx="${i}">
                <div class="place-item-icon"><i class="fa-solid fa-location-dot"></i></div>
                <div class="place-item-info">
                    <div class="place-name">${p.name}</div>
                    ${sub ? `<div class="place-sub">${sub}</div>` : ''}
                </div>
            </div>`;
        }).join('');
        suggestionsBox.style.display = 'block';

        suggestionsBox.querySelectorAll('.place-item').forEach(item => {
            item.addEventListener('mousedown', (e) => e.preventDefault());
            item.addEventListener('click', () => selectPlace(activeSuggestions[parseInt(item.dataset.idx)]));
            item.addEventListener('touchstart', () => item.classList.add('active'), { passive: true });
            item.addEventListener('touchend', (e) => {
                e.preventDefault();
                item.classList.remove('active');
                selectPlace(activeSuggestions[parseInt(item.dataset.idx)]);
            });
            item.addEventListener('touchcancel', () => item.classList.remove('active'));
        });
    }

    function closeSuggestions() {
        suggestionsBox.style.display = 'none';
        activeSuggestions = [];
        activeIdx = -1;
    }

    function showSelectedPill(name) {
        if (selectedPill && selectedText) {
            selectedText.textContent = name;
            selectedPill.style.display = 'flex';
        }
    }

    function hideSelectedPill() {
        if (selectedPill) selectedPill.style.display = 'none';
    }

    function selectPlace(place) {
        if (!place) return;
        closeSuggestions();
        input.value = '';
        clearBtn && (clearBtn.style.display = 'none');
        const fullName = [place.name, place.region, place.country].filter(Boolean).join(', ');
        state.userLocationName = fullName;
        state.locationName = fullName;
        // P1.3 — Previously, if the selected place had no lat/lng AND the
        // device had no GPS fix, we wrote {lat: 0, lng: 0} — which clusters
        // every such report at null-island off the west coast of Africa and
        // silently dropped them from every geo filter on the dashboard.
        // Now: only assign when we have actual coordinates. If a place was
        // picked without coords, keep state.location=null and rely on the
        // name string (stored in state.userLocationName) for backend lookup.
        if (place.lat && place.lng) {
            state.location = { lat: place.lat, lng: place.lng, acc: 0, is_user_corrected: true };
        }
        // else: leave state.location as-is; existing GPS fix (if any) stays,
        // and if nothing was ever resolved, the report is submitted with
        // `location: null` so the backend/dashboard can handle it explicitly
        // rather than mapping it to (0,0).
        showSelectedPill(fullName);
        populateReview();
    }

    function highlightSuggestion(idx) {
        suggestionsBox.querySelectorAll('.place-item').forEach((item, i) => {
            item.classList.toggle('active', i === idx);
        });
    }

    // ── Input events ──────────────────────────────────────────────────────────
    input.addEventListener('input', () => {
        const q = input.value.trim();

        // Show/hide clear button
        if (clearBtn) clearBtn.style.display = q.length ? 'flex' : 'none';

        if (q.length < 3) { closeSuggestions(); return; }

        // Instant offline results — bundled DB + localStorage cache
        const ps = (typeof placeSearch !== 'undefined') ? placeSearch : null;
        const instant = ps ? ps.search(q) : [];
        showSuggestions(instant, true);

        // Background Nominatim enrichment — debounced 700ms, non-blocking
        clearTimeout(remoteDebounce);
        remoteDebounce = setTimeout(() => {
            if (ps) {
                ps.searchRemote(q, () => {
                    if (input.value.trim() === q) showSuggestions(ps.search(q), true);
                });
            }
        }, 700);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, Math.min(activeSuggestions.length, 5) - 1);
            highlightSuggestion(activeIdx);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            highlightSuggestion(activeIdx);
        } else if (e.key === 'Enter' && activeSuggestions.length) {
            e.preventDefault();
            selectPlace(activeSuggestions[activeIdx >= 0 ? activeIdx : 0]);
        } else if (e.key === 'Escape') {
            closeSuggestions();
            input.blur();
        }
    });

    input.addEventListener('blur', () => setTimeout(closeSuggestions, 200));

    // Clear button
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.style.display = 'none';
            closeSuggestions();
            input.focus();
        });
    }

    // Change button on selected pill — let user re-search
    if (changeBtn) {
        changeBtn.addEventListener('click', () => {
            hideSelectedPill();
            // Reset the user correction, restore device GPS
            state.userLocationName = null;
            state.locationName = state.deviceLocationName || null;
            populateReview();
            input.focus();
        });
    }

    // Reposition on stage scroll (stage is the scroll container, not window)
    const stageEl = document.getElementById('stage-review');
    if (stageEl) stageEl.addEventListener('scroll', positionDropdown, { passive: true });
    window.addEventListener('resize', () => { if (suggestionsBox.style.display !== 'none') positionDropdown(); }, { passive: true });
}

function setupReviewStage() {
    // Infrastructure type chip handler is registered together with the
    // inline-severity picker further down (PR 6 merge). Keeping the two in
    // one place avoids the old two-pass "bind then re-bind by clone" dance.

    // Crisis type chips (scoped by data-crisis)
    document.querySelectorAll('.chip-btn[data-crisis]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chip-btn[data-crisis]').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.crisisType = btn.dataset.crisis;
        });
    });

    // PR 6 (Apr 2026): infra-chip click now ALSO drives the inline severity
    // picker below the grid. Tapping the already-selected chip collapses
    // the severity row (but keeps the stored damageClass — silent default
    // PARTIAL is preserved across collapses). Tapping a different chip
    // switches selection + keeps (or opens) the severity row.
    const infraSeverityWrap = document.getElementById('infra-severity');
    const infraSeverityChipName = document.getElementById('infra-severity-chip-name');
    function _refreshInfraSeverityLabel() {
        if (!infraSeverityChipName) return;
        const selected = document.querySelector('.chip-btn[data-type].selected');
        const span = selected ? selected.querySelector('span') : null;
        infraSeverityChipName.textContent = span ? span.textContent : '';
    }
    // InfraType chips: one listener each. Re-tapping the currently-selected
    // chip collapses the severity picker; a different chip switches selection
    // and keeps the picker open.
    document.querySelectorAll('.chip-btn[data-type]').forEach(btn => {
        btn.addEventListener('click', () => {
            const wasSelected = btn.classList.contains('selected');
            const severityOpen = infraSeverityWrap && infraSeverityWrap.style.display === 'block';
            if (wasSelected && severityOpen) {
                infraSeverityWrap.style.display = 'none';
                return;
            }
            document.querySelectorAll('.chip-btn[data-type]').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.infraType = btn.dataset.type;
            if (infraSeverityWrap) infraSeverityWrap.style.display = 'block';
            _refreshInfraSeverityLabel();
        });
    });
    // Initial label sync (default ROAD.selected in the markup).
    _refreshInfraSeverityLabel();

    // Severity chips
    document.querySelectorAll('.sev-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sev-chip').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.severity = btn.dataset.sev;
        });
    });

    // Damage classification chips
    document.querySelectorAll('.damage-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.damage-chip').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.damageClass = btn.dataset.damage;
        });
    });

    // PR 6 (Apr 2026): #toggle-debris and #input-infra-name no longer exist
    // in the DOM (dropped from the review form). state.debrisClearing and
    // state.infraName keep their '' / false defaults so the backend contract
    // (debris_clearing_needed, infrastructure_name) is unchanged.

    // Location autocomplete (instant offline suggestions after 3 chars)
    setupLocationAutocomplete();

    // ── Phase 6: paginate the Review stage (3 pages) ──────────────────────
    // Instead of navigating to a separate stage-send, we flip between three
    // in-stage pages: Incident → Details → Final Review. Each page controls
    // Next / Back / Submit visibility.
    state.reviewPage = 1;
    // Phase 3 (Apr 2026): review collapsed to 2 pages (Details + Confirm).
    // Was 3 (Incident + Details + Final Review). The Incident page's only
    // real field — Description — now sits at the top of Details.
    const TOTAL_REVIEW_PAGES = 2;
    const reviewRoot = document.getElementById('stage-review');
    const btnReviewBack = document.getElementById('btn-review-back');
    const btnReviewNext = document.getElementById('btn-review-next');
    const btnReviewSubmit = document.getElementById('btn-review-submit');

    function _collectServiceStatusFromDom() {
        const elec = document.getElementById('svc-electricity');
        const water = document.getElementById('svc-water');
        const health = document.getElementById('svc-health');
        if (elec) state.serviceStatus.electricity = elec.value;
        if (water) state.serviceStatus.water = water.value;
        if (health) state.serviceStatus.health = health.value;
        const needs = [];
        document.querySelectorAll('.need-chip input:checked').forEach(cb => needs.push(cb.value));
        state.serviceStatus.pressing_needs = needs;
        state.description = document.getElementById('edit-text').value.trim();
    }

    function showReviewPage(n) {
        state.reviewPage = Math.min(Math.max(n, 1), TOTAL_REVIEW_PAGES);
        reviewRoot.setAttribute('data-review-page', String(state.reviewPage));
        document.querySelectorAll('#stage-review .review-page').forEach(el => {
            const p = parseInt(el.getAttribute('data-review-page') || '0', 10);
            el.style.display = (p === state.reviewPage) ? '' : 'none';
        });
        // Step dots: mark the current review page as active.
        // Phase 3: now 4 absolute steps (photo, audio, details, confirm).
        const dots = document.querySelectorAll('#review-page-header .step-dot');
        const absoluteStep = 2 + state.reviewPage; // 1-photo, 2-audio, 3-details, 4-confirm
        dots.forEach((d, i) => {
            d.classList.toggle('active', i + 1 === absoluteStep);
            d.classList.toggle('done', i + 1 < absoluteStep);
        });
        // Apr 2026: was hardcoded English array — non-English locales saw
        // "Details"/"Confirm" in English on the title. Now resolved via t()
        // against `review_details_title` (page 1) and `confirm_title`
        // (page 2 — already in the RN dict, mirrored here).
        const titleKeys = ['review_details_title', 'confirm_title'];
        const titleEl = document.getElementById('review-page-title');
        if (titleEl) titleEl.textContent = t(titleKeys[state.reviewPage - 1]);
        const counter = document.getElementById('review-page-counter');
        if (counter) counter.textContent = `Step ${absoluteStep} of 4`;
        // Button visibility
        btnReviewBack.style.display = state.reviewPage === 1 ? 'none' : 'flex';
        btnReviewNext.style.display = state.reviewPage === TOTAL_REVIEW_PAGES ? 'none' : 'flex';
        btnReviewSubmit.style.display = state.reviewPage === TOTAL_REVIEW_PAGES ? 'flex' : 'none';
        // On Page 3, render the live summary.
        if (state.reviewPage === TOTAL_REVIEW_PAGES) renderReviewSummary();
    }

    function renderReviewSummary() {
        _collectServiceStatusFromDom();
        const summaryEl = document.getElementById('review-summary');
        if (!summaryEl) return;
        const ss = state.serviceStatus || {};
        const needsTxt = (ss.pressing_needs && ss.pressing_needs.length) ? ss.pressing_needs.join(', ') : '—';
        const photoCount = (state.photoDataUrl ? 1 : 0) + (state.extraPhotos || []).length;
        // Phase 3: both Edit links point to page 1 (Details) — that's now the
        // single editable page. The Incident card is kept as a visual block so
        // responders at a glance see the narrative bit separately from the
        // structured details.
        summaryEl.innerHTML = `
          <div class="summary-card">
            <div class="summary-card-head"><strong>${t('summary_incident')}</strong>
              <a href="#" class="summary-edit" data-page="1">${t('summary_edit')}</a></div>
            <p>🌪 ${state.crisisType}  |  📸 ${photoCount} ${t('browse').toLowerCase() === 'files' ? (photoCount === 1 ? 'photo' : 'photos') : ''}  |  🎤 ${state.audioBlob ? '✅' : '❌'}</p>
            ${state.description ? `<p>📝 ${state.description.substring(0, 200)}</p>` : ''}
            ${state.locationName ? `<p>📍 ${state.locationName}</p>` : ''}
          </div>
          <div class="summary-card">
            <div class="summary-card-head"><strong>${t('summary_details')}</strong>
              <a href="#" class="summary-edit" data-page="1">${t('summary_edit')}</a></div>
            <p>📋 ${state.infraType}  |  ⚠ ${state.severity}  |  🏗 ${state.damageClass.replace(/_/g, ' ')}</p>
            ${state.infraName ? `<p>🏛 ${state.infraName}</p>` : ''}
            ${state.debrisClearing ? `<p>${t('summary_debris')}</p>` : ''}
            <p>⚡ ${ss.electricity || 'UNKNOWN'} · 💧 ${ss.water || 'UNKNOWN'} · 🏥 ${ss.health || 'UNKNOWN'}</p>
            <p>${t('summary_needs_prefix')} ${needsTxt}</p>
          </div>`;
        // Edit-link handlers.
        summaryEl.querySelectorAll('.summary-edit').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                showReviewPage(parseInt(a.getAttribute('data-page') || '1', 10));
            });
        });
    }
    // Expose so applyI18n() can re-render the summary when the user
    // changes the locale while viewing it (otherwise the pre-rendered
    // card text stays in the old language until next navigation).
    window.__crispRenderReviewSummary = renderReviewSummary;

    btnReviewNext.addEventListener('click', () => {
        if (state.reviewPage < TOTAL_REVIEW_PAGES) showReviewPage(state.reviewPage + 1);
    });
    btnReviewBack.addEventListener('click', () => {
        if (state.reviewPage > 1) showReviewPage(state.reviewPage - 1);
    });
    btnReviewSubmit.addEventListener('click', () => {
        _collectServiceStatusFromDom();
        // submitReport() handles queue + success overlay.
        submitReport();
    });

    // Reset to page 1 every time the stage is entered.
    document.addEventListener('stage-entered', (e) => {
        if (e.detail === 'stage-review') showReviewPage(1);
    });
}

// ── STAGE 4: Send ──────────────────────────────────────────────────────────────
function populateSendStage() {
    document.getElementById('summary-type').textContent = state.infraType;
    document.getElementById('summary-severity').textContent = state.severity;
    document.getElementById('summary-crisis').textContent = state.crisisType.replace(/_/g, ' ');
    document.getElementById('summary-damage').textContent = state.damageClass.replace(/_/g, ' ');

    // Infrastructure name
    const infraNameRow = document.getElementById('summary-infra-name-row');
    if (state.infraName) {
        document.getElementById('summary-infra-name').textContent = state.infraName;
        infraNameRow.style.display = 'flex';
    } else { infraNameRow.style.display = 'none'; }

    // Debris clearing
    document.getElementById('summary-debris-row').style.display = state.debrisClearing ? 'flex' : 'none';

    const photoRow = document.getElementById('summary-photo-row');
    const summaryPhoto = document.getElementById('summary-photo');
    if (state.photoDataUrl) {
        summaryPhoto.src = state.photoDataUrl;
        photoRow.style.display = 'block';
    } else {
        photoRow.style.display = 'none';
    }

    const textRow = document.getElementById('summary-text-row');
    const summaryText = document.getElementById('summary-text');
    if (state.description) {
        summaryText.textContent = state.description;
        textRow.style.display = 'flex';
    } else {
        textRow.style.display = 'none';
    }

    const locSpan = document.getElementById('summary-loc');
    if (state.userLocationName) {
        locSpan.textContent = state.userLocationName;
    } else if (state.locationName) {
        locSpan.textContent = state.locationName;
    } else if (state.location && (state.location.lat !== 0 || state.location.lng !== 0)) {
        locSpan.textContent = 'Resolving...';
        resolveLocationName(); // will update summary-loc when done
    } else {
        locSpan.textContent = 'Location not set';
    }
}

// ── Media Chunking Utilities (PRD §3.3 / §3.4 / §3.7) ───────────────────────

// Generate a micro-thumbnail from a data URL (sent before full chunks for fast preview)
// Kept tiny (80×80, quality 0.25) so it transfers in ~10-15s even at 1kbps
async function generateThumbnail(dataUrl, maxDim = 80, quality = 0.25) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

// ── PWA Adaptive Network Engine ─────────────────────────────────────────────
// Mirrors crisp-mobile/services/networkAdaptive.ts for browser context
const PWA_NETWORK_TIERS = {
    FAST:      { chunkSize: 524288, retries: 4, timeout: 30000, imageQuality: 0.85, imageMaxWidth: 1280 },  // 512KB (req: 512KB-1MB)
    MEDIUM:    { chunkSize: 131072, retries: 5, timeout: 30000, imageQuality: 0.65, imageMaxWidth: 1024 },  // 128KB (req: 128-512KB)
    SLOW:      { chunkSize: 32768,  retries: 8, timeout: 45000, imageQuality: 0.50, imageMaxWidth: 720  },  // 32KB  (req: 32-128KB)
    VERY_SLOW: { chunkSize: 1024,   retries: 15, timeout: 60000, imageQuality: 0.35, imageMaxWidth: 480  },  // 1KB   (req: 1KB min)
};
let _pwaTier = 'MEDIUM';
let _pwaSuccessStreak = 0;

function detectPWANetworkTier() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!navigator.onLine) { _pwaTier = 'VERY_SLOW'; return _pwaTier; }
    if (conn) {
        const ect = conn.effectiveType; // '4g', '3g', '2g', 'slow-2g'
        const dl = Number(conn.downlink); // Mbps estimate, 0 = "I don't know"
        // Apr 2026 fix: Chrome DevTools throttling leaves `effectiveType` at '4g'
        // regardless of the simulated speed, but DOES update `downlink` — so a
        // reading of `downlink: 0` on '4g' is the browser explicitly telling us
        // it has no reliable measurement. Treat that as "slow until proven
        // otherwise" rather than trusting the optimistic ECT alone. The real
        // truth comes from `adaptTierViaProbe()` at upload-start.
        if (ect === '4g' && dl >= 5)              _pwaTier = 'FAST';
        else if (ect === '4g' && dl >= 1.5)       _pwaTier = 'MEDIUM';
        else if (ect === '4g' && dl > 0)          _pwaTier = 'SLOW';   // slow 4g
        else if (ect === '4g')                    _pwaTier = 'SLOW';   // 4g + dl=0 → unknown, be conservative
        else if (ect === '3g')                    _pwaTier = 'SLOW';
        else                                      _pwaTier = 'VERY_SLOW';
    } else {
        // No Network Information API (Safari + several mobile browsers). Pre-probe
        // default is SLOW — we'd rather pay a few extra round trips on a fast
        // link than time out every chunk on a slow one.
        _pwaTier = 'SLOW';
    }
    console.log(`[PWA Network] Tier (pre-probe): ${_pwaTier}`);
    return _pwaTier;
}

// ── Upload-bandwidth probe (Apr 2026) ──────────────────────────────────────
//
// Chrome DevTools throttling does NOT update `navigator.connection.effectiveType`.
// At 2 Kbps, ECT is still '4g' and our detector (before this fix) defaulted
// to MEDIUM → 128 KB chunks → 30 s XHR timeout → every chunk dies → upload
// stuck for 40+ minutes with zero progress. Confirmed by user diagnostic.
//
// `measureUploadBandwidth()` sends a small POST to `/reports/upload-probe`
// and measures real round-trip time. `adaptTierViaProbe()` then picks the
// tier from the measurement rather than from the browser's optimistic
// signal. The probe itself is cached for 60 s so re-probing every variant
// of the same report is wasteful.

const _PROBE_SIZE_BYTES = 8192;        // 8 KB — enough signal, fast at 2 Kbps (~30 s)
const _PROBE_TIMEOUT_MS = 45_000;      // abort after 45 s even on garbage links
const _PROBE_CACHE_MS = 60_000;        // re-probe at most once per minute

let _lastProbeBytesPerSec = 0;
let _lastProbeAt = 0;

async function measureUploadBandwidth() {
    const probe = new Uint8Array(_PROBE_SIZE_BYTES);
    const fd = new FormData();
    fd.append('data', new Blob([probe], { type: 'application/octet-stream' }), 'probe.bin');

    const url = `${API_BASE}/reports/upload-probe`;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), _PROBE_TIMEOUT_MS) : null;
    const start = performance.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            body: fd,
            cache: 'no-store',
            signal: ctrl ? ctrl.signal : undefined,
        });
        if (!res.ok) {
            if (timer) clearTimeout(timer);
            // 404 → probe endpoint not deployed yet (client ahead of backend).
            // We don't treat that as a signal either way — fall through to
            // NavigatorConnection-based detection.
            console.warn(`[Probe] HTTP ${res.status} — ignoring`);
            return { bytesPerSec: 0, elapsedMs: 0, error: `HTTP ${res.status}` };
        }
        await res.json();           // fully drain the response so the timer reflects complete round-trip
        const elapsedMs = performance.now() - start;
        if (timer) clearTimeout(timer);
        // Throughput over the upload leg only. We ignore the (tiny) JSON
        // response size — it's ~50 bytes vs the 8192-byte payload.
        const bytesPerSec = elapsedMs > 0 ? (_PROBE_SIZE_BYTES / elapsedMs) * 1000 : 0;
        return { bytesPerSec, elapsedMs };
    } catch (e) {
        if (timer) clearTimeout(timer);
        console.warn(`[Probe] failed: ${e.message || e}`);
        return { bytesPerSec: 0, elapsedMs: 0, error: String(e && e.message || e) };
    }
}

/** Map a measured bytes/sec to one of the four tiers. Thresholds sized so
 *  the picked tier's chunk completes within ~15 s at the measured speed. */
function pickTierFromBandwidth(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return 'VERY_SLOW';
    if (bytesPerSec >= 1_000_000) return 'FAST';      // ≥ 8 Mbps
    if (bytesPerSec >= 100_000)   return 'MEDIUM';    // ≥ 800 Kbps
    if (bytesPerSec >= 10_000)    return 'SLOW';      // ≥ 80 Kbps
    return 'VERY_SLOW';                                // below 80 Kbps, incl. the 2 Kbps case
}

/**
 * Pick the network tier from a real upload-bandwidth probe. Falls back
 * to the NavigatorConnection-based `detectPWANetworkTier` on probe
 * failure or stale cache. Updates `_pwaTier` as a side effect so every
 * downstream caller (chunk loop, timeout computation) picks it up.
 *
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string>} the tier name
 */
async function adaptTierViaProbe(opts = {}) {
    const { force = false } = opts;
    const freshEnough = !force &&
        _lastProbeBytesPerSec > 0 &&
        (Date.now() - _lastProbeAt) < _PROBE_CACHE_MS;
    if (freshEnough) {
        _pwaTier = pickTierFromBandwidth(_lastProbeBytesPerSec);
        return _pwaTier;
    }
    const { bytesPerSec, elapsedMs, error } = await measureUploadBandwidth();
    if (bytesPerSec > 0) {
        _lastProbeBytesPerSec = bytesPerSec;
        _lastProbeAt = Date.now();
        _pwaTier = pickTierFromBandwidth(bytesPerSec);
        console.log(
            `[Probe] ${Math.round(bytesPerSec).toLocaleString()} B/s ` +
            `(${elapsedMs.toFixed(0)} ms) → tier ${_pwaTier}`
        );
    } else {
        // Probe failed — fall back to the browser hint (already conservative).
        console.log(`[Probe] no measurement (${error || 'n/a'}); falling back to NavigatorConnection tier`);
        detectPWANetworkTier();
    }
    return _pwaTier;
}

/**
 * Compute a chunk-upload timeout scaled to actual measured throughput.
 * 3× the expected transfer time + 5 s fixed buffer, floored at 10 s.
 * When we don't have a measurement yet, falls back to the tier-table
 * default — but the outer probe should have run first, so this branch
 * is hit only for the first probe itself or when probe failed.
 */
function computeChunkTimeout(chunkSize, measuredBytesPerSec = null) {
    if (measuredBytesPerSec && measuredBytesPerSec > 0) {
        const estimatedMs = (chunkSize / measuredBytesPerSec) * 1000;
        return Math.max(10_000, Math.ceil(estimatedMs * 3 + 5_000));
    }
    return (getPWAAdaptiveConfig().timeout) || 30_000;
}

/** Accessor for the last measured upload bandwidth. Returns 0 until the
 *  first successful probe. Used by `computeChunkTimeout` + tests. */
function getMeasuredBandwidth() { return _lastProbeBytesPerSec; }

/** Accessor for the current active tier. `_pwaTier` is a `let` binding
 *  so it's not exposed on `window`; tests + the dashboard debug panel
 *  read via this getter instead. */
function getCurrentPWATier() { return _pwaTier; }

function getPWAAdaptiveConfig() { return PWA_NETWORK_TIERS[_pwaTier]; }

function pwaNetworkDowngrade() {
    const order = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'];
    const idx = order.indexOf(_pwaTier);
    if (idx < order.length - 1) { _pwaTier = order[idx + 1]; console.log(`[PWA Network] Downgraded → ${_pwaTier}`); }
    _pwaSuccessStreak = 0;
}

function pwaNetworkUpgrade() {
    _pwaSuccessStreak++;
    if (_pwaSuccessStreak >= 10) {
        const order = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'];
        const idx = order.indexOf(_pwaTier);
        if (idx > 0) { _pwaTier = order[idx - 1]; console.log(`[PWA Network] Upgraded → ${_pwaTier}`); }
        _pwaSuccessStreak = 0;
    }
}

// Split a base64 string into chunks (adaptive size, default 1024 for backward compat)
function chunkBase64(b64str, chunkChars = 1024) {
    const chunks = [];
    for (let i = 0; i < b64str.length; i += chunkChars) {
        chunks.push(b64str.slice(i, i + chunkChars));
    }
    return chunks;
}

// djb2 checksum — must match Python djb2_checksum() on the backend (PRD §3.7)
function simpleChecksum(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

// UUID generator (works on HTTP, unlike crypto.randomUUID)
function genUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// P3.4 — Lightweight telemetry wrapper for what used to be `catch(_) {}`.
// Records the last 100 swallowed errors (timestamp + context + message +
// stack) so a debug screen — or a future Sentry hook — can surface them.
// Never throws. Callers that truly want silence can still use a bare catch.
window._crispTelemetry = window._crispTelemetry || { events: [] };
function _silent(context, err) {
    try {
        const msg = (err && err.message) || String(err);
        const stack = (err && err.stack) ? err.stack : undefined;
        console.warn('[silent:' + context + ']', msg, stack ? '\n' + stack : '');
        const ev = { context, message: msg, stack, timestamp: Date.now() };
        window._crispTelemetry.events.push(ev);
        if (window._crispTelemetry.events.length > 100) window._crispTelemetry.events.shift();
    } catch (_) {
        // telemetry must never throw
    }
}

// ── Progressive Upload Helper ────────────────────────────────────────────────
// XHR-based sender with hard timeout. fetch() hangs on slow networks — XHR doesn't.
function sendJSON(url, payload, timeoutMs = 30000) {
    // POST for meta, chunk, thumbnail — PATCH for everything else
    const method = /\/(meta|chunk|thumbnail)$/.test(url) ? 'POST' : 'PATCH';
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = timeoutMs;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { resolve(JSON.parse(xhr.responseText)); }
                catch (e) { reject(new Error('Invalid JSON response')); }
            } else {
                reject(new Error(`HTTP ${xhr.status}`));
            }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timeout'));
        xhr.send(JSON.stringify(payload));
    });
}

// Retry wrapper: tries up to `retries` times with exponential backoff
async function sendWithRetry(url, payload, retries = 5, timeoutMs = 30000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await sendJSON(url, payload, timeoutMs);
        } catch (err) {
            console.warn(`Attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
            if (attempt === retries) throw err;
            // Backoff: 2s, 4s, 8s, 16s, 32s
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
        }
    }
}

// ── UNDP §5 binary-chunk transport (Apr 2026, Option A) ──────────────────────
// Master feature flag for the new transport. Default ON — every new build
// uses binary chunks. If the flag is off, every call-site falls back to the
// legacy base64 path without any behavioural change.
//
// Disable via `localStorage.setItem('crisp_binary_chunks', 'off')` in an
// incident to force-revert every client to base64. Useful if a bug in the
// new endpoint emerges in prod.
function isBinaryChunksEnabled() {
    try {
        if (localStorage.getItem('crisp_binary_chunks') === 'off') return false;
    } catch (_) { /* private-mode storage throws — default to ON */ }
    return true;
}

/**
 * djb2 hash over a byte sequence. Mirrors `djb2_bytes` in
 * `backend/app/api/endpoints/reports.py`. Used ONLY by the binary
 * chunk path — the legacy path keeps calling `simpleChecksum(string)`
 * which is the text-alphabet variant.
 *
 * Same polynomial as the existing `simpleChecksum` — only the input
 * type differs. For pure-ASCII inputs the two helpers produce identical
 * output (ord(char) === byte on ASCII).
 */
function djb2Bytes(bytes) {
    let h = 5381;
    for (let i = 0; i < bytes.length; i++) {
        h = (((h << 5) + h) ^ bytes[i]) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Send a multipart/form-data POST with XHR (fetch hangs on slow
 * networks the same way `sendJSON` does, so we match its pattern).
 * Returns the parsed JSON response body on 2xx; rejects with an
 * Error whose `.status` reflects the HTTP code so call-sites can
 * distinguish a 404 (legacy backend — fall back to base64) from
 * a 5xx (retry).
 */
function sendFormData(url, formData, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        // DO NOT set Content-Type — the browser needs to generate it
        // with the multipart boundary. Setting it manually breaks the
        // upload silently.
        xhr.timeout = timeoutMs;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { resolve(JSON.parse(xhr.responseText)); }
                catch (_) { resolve({}); }
            } else {
                const err = new Error(`HTTP ${xhr.status}`);
                err.status = xhr.status;
                reject(err);
            }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Timeout'));
        xhr.send(formData);
    });
}

/**
 * Upload a single chunk as raw bytes via multipart/form-data.
 *
 * @param {string} reportId
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {number} params.seqNum
 * @param {number} params.totalChunks
 * @param {Blob|Uint8Array|ArrayBuffer} params.blob  — the raw-byte chunk payload
 * @param {'IMAGE'|'AUDIO'} params.type
 * @param {'LOW'|'MEDIUM'|'HIGH'|'ORIGINAL'} params.resolutionTier
 * @param {string|null} params.photoGroupId
 * @param {boolean} params.clientBlurApplied
 * @param {string|null} params.checksum  — hex djb2 over the raw bytes (null → skip)
 * @param {number} [retries=5]
 * @param {number} [timeoutMs=30000]
 *
 * Auto-falls-back to the base64 endpoint if the server returns 404
 * (legacy deployment without the new endpoint). First-time fallback
 * logs a warning; subsequent chunks in the same session go straight
 * to base64 without retrying the 404 path.
 */
let _binaryChunkFallback404 = false; // session-scoped sticky flag

async function sendBinaryChunkWithRetry(reportId, params, retries = 5, timeoutMs = 30000) {
    const {
        mediaId, seqNum, totalChunks, blob, type,
        resolutionTier, photoGroupId, clientBlurApplied, checksum,
    } = params;

    // Quick fallback if we already know the backend doesn't support /chunk-bin.
    if (_binaryChunkFallback404) {
        return await _sendLegacyB64Chunk(reportId, params, retries, timeoutMs);
    }

    const url = `${API_BASE}/reports/${reportId}/media/chunk-bin`;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const fd = new FormData();
            fd.append('media_id', mediaId);
            fd.append('seq_num', String(seqNum));
            fd.append('total_chunks', String(totalChunks));
            fd.append('type', type);
            fd.append('resolution_tier', resolutionTier || 'LOW');
            if (photoGroupId) fd.append('photo_group_id', photoGroupId);
            fd.append('client_blur_applied', clientBlurApplied ? 'true' : 'false');
            if (checksum) fd.append('checksum', checksum);
            // Wrap raw bytes in a Blob so the multipart file part is sent
            // without any transcoding. Buffer / Uint8Array / Blob all work.
            const asBlob = (blob instanceof Blob) ? blob
                : (blob instanceof ArrayBuffer || ArrayBuffer.isView(blob)) ? new Blob([blob])
                : new Blob([blob]);
            fd.append('data', asBlob, 'chunk.bin');
            return await sendFormData(url, fd, timeoutMs);
        } catch (err) {
            // 404 means this backend doesn't know about /chunk-bin yet.
            // Switch the entire session to base64 and retry legacy.
            if (err.status === 404) {
                console.warn('[BinaryChunks] /chunk-bin returned 404 — falling back to base64 for the rest of this session');
                _binaryChunkFallback404 = true;
                return await _sendLegacyB64Chunk(reportId, params, retries, timeoutMs);
            }
            console.warn(`[BinaryChunks] attempt ${attempt}/${retries} failed for seq=${seqNum}: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
        }
    }
}

/**
 * Fallback: encode the blob to base64 and ship it via the legacy
 * /media/chunk endpoint. Preserves every existing behavioural guard so
 * a partial rollout (new client + old backend) degrades gracefully.
 */
async function _sendLegacyB64Chunk(reportId, params, retries, timeoutMs) {
    const {
        mediaId, seqNum, totalChunks, blob, type,
        resolutionTier, photoGroupId, clientBlurApplied,
    } = params;
    // Read the chunk as base64.
    const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const r = String(fr.result || '');
            resolve(r.includes(',') ? r.split(',')[1] : r);
        };
        fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
        const asBlob = (blob instanceof Blob) ? blob : new Blob([blob]);
        fr.readAsDataURL(asBlob);
    });
    return await sendWithRetry(
        `${API_BASE}/reports/${reportId}/media/chunk`,
        {
            media_id: mediaId, type,
            seq_num: seqNum, total_chunks: totalChunks,
            data: b64, checksum: simpleChecksum(b64),
            resolution_tier: resolutionTier || 'LOW',
            photo_group_id: photoGroupId || null,
            client_blur_applied: Boolean(clientBlurApplied),
        },
        retries, timeoutMs,
    );
}

/**
 * Upload a full media Blob as binary chunks. Mirrors the structure of
 * the legacy base64 loop: detects the network tier, slices the Blob
 * into `chunkSize`-byte pieces, uploads in order with retry.
 *
 * @returns {Promise<{totalChunks:number}>}
 */
async function uploadChunksBinary(reportId, mediaId, blob, {
    type = 'IMAGE', resolutionTier = 'LOW', photoGroupId = null,
    clientBlurApplied = false, startSeq = 0,
    onProgress = null,
} = {}) {
    detectPWANetworkTier();
    const netConfig = getPWAAdaptiveConfig();
    const chunkSize = netConfig.chunkSize;
    const total = Math.max(1, Math.ceil(blob.size / chunkSize));

    for (let seq = startSeq; seq < total; seq++) {
        const start = seq * chunkSize;
        const end = Math.min(start + chunkSize, blob.size);
        const slice = blob.slice(start, end);

        // Compute djb2 over raw bytes so the server can verify integrity.
        // `blob.slice` is zero-copy — we only read the bytes here to hash.
        const buf = new Uint8Array(await slice.arrayBuffer());
        const checksum = djb2Bytes(buf);

        await sendBinaryChunkWithRetry(
            reportId,
            {
                mediaId, seqNum: seq, totalChunks: total, blob: slice,
                type, resolutionTier, photoGroupId, clientBlurApplied, checksum,
            },
            netConfig.retries, netConfig.timeout,
        );
        pwaNetworkUpgrade();   // streak-based upgrade on each successful chunk
        if (onProgress) onProgress(seq + 1, total);
    }
    return { totalChunks: total };
}

async function submitReport() {
    // Phase 6: btn-send was on the old stage-send; btn-review-submit is on
    // the new review page 3. Either may exist in a given session.
    const sendBtn = document.getElementById('btn-send') || document.getElementById('btn-review-submit');
    if (sendBtn) sendBtn.disabled = true;

    try {
        // Phase 1: if a face-blur is still in flight (user was faster than
        // BlazeFace), wait for it to finish before snapshotting state.photoBlob.
        // Non-fatal — raw blob will be used if the blur errors.
        await awaitPendingBlur();

        // Generate idempotency key (use shared genUUID() — single source of truth)
        const clientReportId = genUUID();

        // P3.2 — Stronger device hash. Previously `DEV-<8 hex chars>` used
        // only 32 bits of entropy — theoretically a 1-in-65K birthday
        // collision across 10K devices, which would pollute badge + report
        // counts for the colliding devices. We now generate once (on first
        // use) a SHA-256 of {UUID + UA + screen + timezone + install time}
        // and cache that in localStorage. 128 bits of effective entropy,
        // still anonymous (no PII sent), still stable across sessions.
        const deviceHash = localStorage.getItem('crisp_device_id_v2') || await (async () => {
            const seed = [
                (crypto?.randomUUID?.() || Math.random().toString(36)),
                navigator.userAgent || '',
                `${screen.width}x${screen.height}x${screen.colorDepth || 0}`,
                Intl.DateTimeFormat().resolvedOptions().timeZone || '',
                String(Date.now()),
            ].join('|');
            let hex;
            try {
                const buf = new TextEncoder().encode(seed);
                const hash = await crypto.subtle.digest('SHA-256', buf);
                hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (_) {
                // Very old browsers without SubtleCrypto — fall back to
                // something stronger than the old 8-hex scheme: two UUIDs.
                hex = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) +
                      (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
                hex = hex.replace(/-/g, '').slice(0, 64);
            }
            const id = 'PWA-' + hex.slice(0, 32);  // 128 bits; prefix marks the channel
            localStorage.setItem('crisp_device_id_v2', id);
            // One-time carry-forward: if the legacy id exists, store it too
            // so the reporter's badge/history continues to accrue on the new id.
            const legacy = localStorage.getItem('crisp_device_id');
            if (legacy) localStorage.setItem('crisp_device_id_legacy', legacy);
            return id;
        })();

        const hasPhoto = !!state.photoDataUrl;
        const hasAudio = !!state.audioBlob;
        const extraPhotoCount = state.extraPhotos.length;
        // Guaranteed-delivery: each photo with variants becomes 3 Media rows
        // on the backend (SMALL/MEDIUM/LARGE) vs 1 without. Count accurately
        // so `expected_media` matches what the server will ultimately see —
        // otherwise the report never flips to SYNCED.
        const mainHasVariants = !!(state.photoVariants && state.photoVariants.small);
        const extrasWithVariants = state.extraPhotos.filter(e => e.variants && e.variants.small).length;
        const extrasWithoutVariants = extraPhotoCount - extrasWithVariants;
        const expectedMedia =
            (hasPhoto ? (mainHasVariants ? 3 : 1) : 0) +
            (extrasWithVariants * 3) + extrasWithoutVariants +
            (hasAudio ? 1 : 0);

        // Build queue item with all data
        const queueItem = {
            client_report_id: clientReportId,
            meta: {
                client_report_id: clientReportId,
                device_hash: deviceHash,
                source: 'APP',
                severity: state.severity,
                infrastructure_type: state.infraType,
                description: '', // Split to Stage 2 for 1KBPS safety
                is_auto_submitted: state.isAutoSubmit,
                client_created_at: new Date().toISOString(),
                expected_media: expectedMedia,
                // UNDP required fields
                crisis_type: state.crisisType,
                damage_classification: state.damageClass,
                infrastructure_name: state.infraName || null,
                debris_clearing_needed: state.debrisClearing,
                service_status: state.serviceStatus,
                // User-selected building footprint from the Leaflet overlay
                // on stage-review. Null unless the user explicitly tapped
                // a polygon; the server's `_auto_assign_building_id` still
                // runs as a coarse fallback when absent.
                building_id: (typeof state.buildingId === 'string' && state.buildingId) || null,
                // P1.3 — NEVER fall back to {latitude:0,longitude:0}. If no
                // real coordinates are available, send location: null so the
                // backend/dashboard handle it explicitly (pure text-based
                // report) instead of plotting every missing-location report
                // at null-island off west Africa and silently dropping them
                // from all geo filters.
                location: state.location
                    ? {
                        latitude: state.location.lat,
                        longitude: state.location.lng,
                        accuracy_meters: state.location.acc || 0,
                        is_user_corrected: !!state.location.is_user_corrected,
                        device_latitude: state.deviceLocation ? state.deviceLocation.lat : null,
                        device_longitude: state.deviceLocation ? state.deviceLocation.lng : null,
                        user_location_name: state.userLocationName || null,
                        device_location_name: (!state.userLocationName && state.locationName) ? state.locationName : null
                    }
                    : null
            },
            photo: hasPhoto ? state.photoDataUrl : null,
            photoSize: hasPhoto ? (state.photoBlob?.size || 0) : 0,
            // Truthful client_blur_applied for the legacy (no-variants)
            // upload path. Same pattern as the variant fields above.
            clientBlurApplied: Boolean(state.photoClientBlurApplied),
            extraPhotos: state.extraPhotos.map(ep => ep.dataUrl),
            audioBlob: null,
            audioSize: 0,
            text: state.description || state.transcript || '',
            stages: { meta: false, text: false, photo: !hasPhoto, audio: !hasAudio },
            serverId: null,
            // Stable media IDs for idempotent chunked uploads (PRD §3.3).
            // When variants are present, photoMediaId is unused — each tier
            // carries its own mediaId in photoVariants.
            photoMediaId: hasPhoto ? genUUID() : null,
            audioMediaId: hasAudio ? genUUID() : null,
            photoChunkProgress: 0,  // last successfully sent chunk index (for resume)
            audioChunkProgress: 0,
            // ── Guaranteed-delivery variants ─────────────────────────────
            // Main photo: per-tier base64 data URL + stable media id + resume
            // offset. Absent if ImageVariants failed to generate.
            photoGroupId: hasPhoto ? (state.photoGroupId || genUUID()) : null,
            photoVariants: (hasPhoto && mainHasVariants) ? {
                // Apr 2026 — truthful client_blur_applied. Was hardcoded `true`
                // at every upload call-site, which silently let PII through
                // whenever BlazeFace failed (CDN blocked, paint crash, model
                // missing). Now sourced from the actual blur pipeline result
                // on `state.photoClientBlurApplied` (set by _blurIfPossible /
                // ImageVariants.generate). `undefined` on legacy-path reports
                // still has a sane default via `Boolean()`.
                clientBlurApplied: Boolean(state.photoVariants.clientBlurApplied ?? state.photoClientBlurApplied),
                small:  { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: state.photoVariants.small.bytes },
                medium: { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: state.photoVariants.medium.bytes },
                large:  { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: state.photoVariants.large.bytes },
            } : null,
            // Extras: each entry mirrors the main-photo structure.
            extraPhotosVariants: state.extraPhotos.map(ep => ep.variants ? {
                groupId: ep.groupId || genUUID(),
                clientBlurApplied: Boolean(ep.variants.clientBlurApplied ?? ep.clientBlurApplied),
                small:  { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: ep.variants.small.bytes },
                medium: { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: ep.variants.medium.bytes },
                large:  { dataUrl: null, mediaId: genUUID(), chunkProgress: 0, complete: false, size: ep.variants.large.bytes },
            } : null),
        };

        // Encode each photo variant's blob to a data URL so IndexedDB can
        // persist them across app restarts (Blobs survive IDB but data URLs
        // survive app-restart + storage-migration more predictably in
        // older browsers). Runs AFTER the structural queueItem has been
        // built, so we mutate its variant entries in place.
        async function _encodeVariants(variantsObj, sourceTriple) {
            if (!variantsObj || !sourceTriple) return;
            for (const tier of ['small', 'medium', 'large']) {
                if (sourceTriple[tier]?.blob) {
                    try {
                        variantsObj[tier].dataUrl = await _blobToDataUrl(sourceTriple[tier].blob);
                    } catch (e) {
                        console.warn(`[submitReport] failed to encode ${tier} variant:`, e);
                    }
                }
            }
        }
        if (queueItem.photoVariants) {
            await _encodeVariants(queueItem.photoVariants, state.photoVariants);
        }
        for (let i = 0; i < queueItem.extraPhotosVariants.length; i++) {
            await _encodeVariants(queueItem.extraPhotosVariants[i], state.extraPhotos[i]?.variants);
        }

        // Encode audio to base64
        if (hasAudio) {
            try {
                const audioBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(state.audioBlob);
                });
                queueItem.audioBlob = audioBase64;
                queueItem.audioSize = state.audioBlob.size;
            } catch (e) {
                console.warn('Audio encode failed:', e);
                queueItem.stages.audio = true; // skip audio
            }
        }

        // ── SAVE TO QUEUE FIRST — this is the safety net ─────────────────────
        // P1.4 — Previously the enqueue error was swallowed with `catch(_){}`,
        // so if IndexedDB was full/quota-exceeded or corrupt, the user would
        // see "success" while nothing was actually persisted (silent data
        // loss including all extra photos held in memory). Now we await the
        // write and surface a real error if it fails.
        try {
            await enqueueReport(queueItem);
            console.log('Report queued:', clientReportId, 'media expected:', expectedMedia);
        } catch (persistErr) {
            console.error('[submitReport] enqueueReport failed:', persistErr);
            hideUploadOverlay();
            if (typeof showToast === 'function') {
                showToast(t('storage_full_toast'));
            } else {
                alert(t('storage_full_alert'));
            }
            sendBtn.disabled = false;
            return;   // do NOT flip to success; user keeps the filled form
        }

        // ── Show success to user IMMEDIATELY — don't wait for network ────────
        showUploadOverlay(t('upload_sending'));
        updateUploadProgress(50, t('upload_saved'));
        document.getElementById('report-id-text').textContent = clientReportId.slice(0, 8).toUpperCase();

        // PR 7: stash the just-submitted report so the Track button on the
        // success screen can open the detail view before the next status-since
        // poll brings back server-authoritative data.
        _synthesizeSubmittedReport(clientReportId, {});

        // Brief pause so user sees the overlay
        await new Promise(r => setTimeout(r, 800));
        showUploadSuccess();
        setTimeout(() => goToStage('stage-success'), 1200);

        // Fetch gamification badge (non-blocking)
        fetchBadge(deviceHash);

        // ── Now try to send in background (non-blocking) ─────────────────────
        trySendQueuedReport(queueItem);

        // ── Clear capture state ──────────────────────────────────────────────
        // From here the report lives in IndexedDB; the UI state variables and
        // preview <img>.src values are no longer needed and actively harmful
        // (prior-report bleed-through on the next capture). Clearing here —
        // instead of only on the "Add another report" button — means every
        // downstream path to a new capture (btn-start, my-reports → home,
        // service-worker reload, browser back) starts from a clean slate.
        // Pure state clear, no navigation — navigation is driven by the
        // setTimeout above.
        _clearCaptureState();

    } catch (fatalErr) {
        console.error('submitReport fatal error:', fatalErr);
        hideUploadOverlay();
        document.getElementById('report-id-text').textContent = 'SAVED';
        goToStage('stage-success');
        sendBtn.disabled = false;
    }
}

// ── Guaranteed-delivery helpers (tier-first variant upload) ─────────────────
//
// Each photo lives as 3 variants (SMALL/MEDIUM/LARGE) sharing a
// `photo_group_id`. We batch work tier-first so:
//   pass 1: SMALL of photo#1 → SMALL of photo#2 → SMALL of photo#N
//   pass 2: MEDIUM of each …
//   pass 3: LARGE of each …
//
// A failure mid-pass leaves per-variant `chunkProgress` on disk so the next
// `trySendQueuedReport` call resumes exactly where it left off. The backend
// is idempotent on (media_id, seq_num) so re-sending a completed chunk is
// a no-op.

const _TIER_MAP = { small: 'LOW', medium: 'MEDIUM', large: 'HIGH' };

function _buildVariantWork(item) {
    const out = [];
    const tiers = ['small', 'medium', 'large'];
    for (const tier of tiers) {
        if (item.photoVariants && item.photoVariants[tier]) {
            out.push({
                tier,
                groupId: item.photoGroupId,
                variant: item.photoVariants[tier],
                // Apr 2026 — propagate the truthful client_blur_applied
                // flag from the parent photo onto each work unit so the
                // upload loop can send it per-chunk. Previously every
                // chunk hardcoded `client_blur_applied: true`, which
                // hid client-side blur failures from the server.
                clientBlurApplied: Boolean(item.photoVariants.clientBlurApplied),
                label: `main/${tier}`,
            });
        }
        for (let i = 0; i < (item.extraPhotosVariants || []).length; i++) {
            const ev = item.extraPhotosVariants[i];
            if (!ev || !ev[tier]) continue;
            out.push({
                tier,
                groupId: ev.groupId,
                variant: ev[tier],
                clientBlurApplied: Boolean(ev.clientBlurApplied),
                label: `extra[${i}]/${tier}`,
            });
        }
    }
    return out;
}

async function _uploadVariantTier(item, reportId, unit) {
    const { tier, groupId, variant, label, clientBlurApplied } = unit;
    if (variant.complete) return;
    if (!variant.dataUrl) {
        console.warn(`[Upload] ${label}: missing dataUrl (skip)`);
        return;
    }
    // Apr 2026 — adaptive bandwidth probe BEFORE first chunk. Picks
    // tier from actual measured throughput rather than trusting
    // `navigator.connection.effectiveType` (which Chrome DevTools
    // throttling doesn't update). Cached 60 s so three variants of the
    // same report share one probe. On probe failure the fallback hint
    // from NavigatorConnection is used — both code paths update
    // `_pwaTier` as a side effect.
    await adaptTierViaProbe();
    const netConfig = getPWAAdaptiveConfig();
    const startSeq = variant.chunkProgress || 0;
    const mediaId = variant.mediaId;
    const resolution = _TIER_MAP[tier];
    // Dynamic timeout sized to the measured throughput. With a 2 Kbps
    // link measured by the probe → picks VERY_SLOW (1 KB chunks) and
    // each chunk gets ~17 s timeout (4 s expected × 3 + 5 s buffer).
    // With a real 4G link → FAST tier (512 KB) and ~15 s timeout. Both
    // comfortably fit a healthy upload and both surface a genuine
    // failure within a reasonable wall-clock window.
    const measuredBps = getMeasuredBandwidth();
    const dynamicTimeout = computeChunkTimeout(netConfig.chunkSize, measuredBps || null);

    // UNDP §5 (Apr 2026) — binary-chunk transport. When the feature flag
    // is enabled (default), upload the variant as raw bytes via
    // multipart/form-data. If the backend returns 404 on the new
    // endpoint, sendBinaryChunkWithRetry falls back to base64
    // automatically and sets a session-sticky flag so subsequent
    // variants skip the 404 retry.
    if (isBinaryChunksEnabled()) {
        // Convert the stored dataUrl back into a Blob for zero-copy
        // slicing. Ephemeral — doesn't replace the persisted dataUrl
        // (which stays JSON-serialisable for IndexedDB crash recovery).
        const blob = _dataUrlToBlob(variant.dataUrl);
        const chunkSize = netConfig.chunkSize;
        const total = Math.max(1, Math.ceil(blob.size / chunkSize));

        console.log(`[Upload:bin] ${label}: ${total} chunks from seq ${startSeq}, tier=${resolution}, netTier=${_pwaTier}`);
        for (let seq = startSeq; seq < total; seq++) {
            const start = seq * chunkSize;
            const end = Math.min(start + chunkSize, blob.size);
            const slice = blob.slice(start, end);
            const buf = new Uint8Array(await slice.arrayBuffer());
            try {
                await sendBinaryChunkWithRetry(
                    reportId,
                    {
                        mediaId,
                        seqNum: seq,
                        totalChunks: total,
                        blob: slice,
                        type: 'IMAGE',
                        resolutionTier: resolution,
                        photoGroupId: groupId,
                        // Apr 2026 — TRUTHFUL flag. `false` → server runs
                        // its own PII blur. Was hardcoded `true` which
                        // let BlazeFace failures leak unblurred PII.
                        clientBlurApplied: Boolean(clientBlurApplied),
                        checksum: djb2Bytes(buf),
                    },
                    netConfig.retries, dynamicTimeout,
                );
                pwaNetworkUpgrade();
            } catch (err) {
                pwaNetworkDowngrade();
                variant.chunkProgress = seq;
                try { await enqueueReport(item); } catch (_) {}
                throw err;
            }
            variant.chunkProgress = seq + 1;
            if ((seq + 1) % 5 === 0) {
                try { await enqueueReport(item); } catch (_) {}
            }
        }
        variant.complete = true;
        try { await enqueueReport(item); } catch (_) {}
        console.log(`[Upload:bin] ${label}: DONE`);
        return;
    }

    // ── Legacy base64 path (feature flag off) ───────────────────────────
    const b64 = variant.dataUrl.includes(',') ? variant.dataUrl.split(',')[1] : variant.dataUrl;
    const chunks = chunkBase64(b64, netConfig.chunkSize);
    const total = chunks.length;

    console.log(`[Upload] ${label}: ${total} chunks from seq ${startSeq}, tier=${resolution}, netTier=${_pwaTier}`);

    for (let seq = startSeq; seq < total; seq++) {
        const data = chunks[seq];
        try {
            await sendWithRetry(
                `${API_BASE}/reports/${reportId}/media/chunk`,
                {
                    media_id: mediaId,
                    type: 'IMAGE',
                    seq_num: seq,
                    total_chunks: total,
                    data,
                    checksum: simpleChecksum(data),
                    resolution_tier: resolution,
                    photo_group_id: groupId,
                    // Apr 2026 — TRUTHFUL flag. Sourced from the variant
                    // pipeline's actual blur result, not hardcoded true.
                    // If the client-side blur failed for any reason, we
                    // send `false` and the server performs its own PII
                    // pass on assembly.
                    client_blur_applied: Boolean(clientBlurApplied),
                },
                netConfig.retries, dynamicTimeout
            );
            pwaNetworkUpgrade();
        } catch (err) {
            pwaNetworkDowngrade();
            // Persist the partial progress before bubbling out so a future
            // retry picks up from `seq`, not from 0.
            variant.chunkProgress = seq;
            try { await enqueueReport(item); } catch (_) {}
            throw err;
        }
        variant.chunkProgress = seq + 1;
        // Checkpoint every 5 chunks for crash recovery.
        if ((seq + 1) % 5 === 0) {
            try { await enqueueReport(item); } catch (_) {}
        }
    }
    variant.complete = true;
    try { await enqueueReport(item); } catch (_) {}
}

async function _uploadLegacyPhoto(item, reportId) {
    const mediaId = item.photoMediaId || genUUID();
    item.photoMediaId = mediaId;
    detectPWANetworkTier();
    const netConfig = getPWAAdaptiveConfig();
    const b64 = item.photo.includes(',') ? item.photo.split(',')[1] : item.photo;
    const chunks = chunkBase64(b64, netConfig.chunkSize);
    const total = chunks.length;
    const startSeq = item.photoChunkProgress || 0;
    if (startSeq === 0) {
        try {
            const thumb = await generateThumbnail(item.photo);
            if (thumb) {
                await sendWithRetry(
                    `${API_BASE}/reports/${reportId}/media/thumbnail`,
                    { media_id: mediaId, thumbnail_data: thumb }, 3, 15000);
            }
        } catch (e) { console.warn('Thumbnail failed (non-fatal):', e.message); }
    }
    // Apr 2026 — truthful flag for the legacy (no-variants) path too.
    // If a reporter's photo went through _blurIfPossible and BlazeFace
    // failed, we now correctly report `false` so the server's PII pass
    // runs. `item.clientBlurApplied` is set at queue-construction time
    // from `state.photoClientBlurApplied`.
    const legacyClientBlurApplied = Boolean(item.clientBlurApplied);
    for (let seq = startSeq; seq < total; seq++) {
        await sendWithRetry(
            `${API_BASE}/reports/${reportId}/media/chunk`,
            {
                media_id: mediaId, type: 'IMAGE',
                seq_num: seq, total_chunks: total,
                data: chunks[seq], checksum: simpleChecksum(chunks[seq]),
                client_blur_applied: legacyClientBlurApplied,
            },
            netConfig.retries, netConfig.timeout
        );
        item.photoChunkProgress = seq + 1;
        if ((seq + 1) % 5 === 0) { try { await enqueueReport(item); } catch (_) {} }
    }
    item.stages.photo = true;
    item.photo = null;
    try { await enqueueReport(item); } catch (_) {}
    console.log(`Legacy photo sent: ${total} chunks`);
}

// ── Background sender: processes one queued report through all stages ─────────
// Apr 2026 — in-flight guard. `startRetryLoop` fires every N seconds
// and can call `trySendQueuedReport` on the SAME item that the primary
// submit flow is already processing. Duplicate POSTs waste bandwidth
// we can't spare on 2 Kbps links and produce redundant retries in the
// console log (observed in field test). Key is the client_report_id
// so two distinct items can still process concurrently.
const _inFlightReports = new Set();

async function trySendQueuedReport(item) {
    const crid = item.client_report_id || item.meta?.client_report_id;
    if (crid && _inFlightReports.has(crid)) {
        console.log(`[Sync] ${crid.slice(0,8)} already in flight — skip duplicate pass`);
        return;
    }
    if (crid) _inFlightReports.add(crid);
    try {
        const stages = item.stages;
        let reportId = item.serverId;

        // Apr 2026 — run the upload-bandwidth probe at the TOP of the
        // send pipeline so every stage (meta, text, chunks) gets a
        // timeout sized to actual throughput. Previously only the chunk
        // loop probed; meta+text used hardcoded 15s/20s timeouts that
        // blow up on 2 Kbps links (confirmed by field test — meta took
        // 4 timeout-retries before finally succeeding).
        await adaptTierViaProbe();
        const measuredBps = getMeasuredBandwidth();

        // Stage 1: Metadata (< 1KB payload). Timeout sized to
        // `computeChunkTimeout(2048, measuredBps)` — at 2 Kbps → ~30 s;
        // at 2 Mbps → 10 s floor. Either way, well over what the request
        // physically needs.
        if (!stages.meta) {
            try {
                const metaTimeout = computeChunkTimeout(2048, measuredBps || null);
                const data = await sendWithRetry(`${API_BASE}/reports/meta`, item.meta, 5, metaTimeout);
                reportId = data.id;
                item.serverId = reportId;
                item.stages.meta = true;
                try { await enqueueReport(item); } catch (_) {}
                console.log(`Stage 1 (meta) sent: ${reportId} (timeout=${metaTimeout}ms)`);
            } catch (e) {
                console.warn('Stage 1 failed, will retry later:', e.message);
                return; // Can't proceed without server ID
            }
        }

        // Stage 2: Text/Description (Tiny, but separate for 1KBPS bursts).
        // Size the timeout to the description length — a reporter who
        // typed a 5 KB essay gets a longer window than one who typed
        // "help". +2 KB overhead for HTTP headers + JSON shell.
        if (!stages.text && reportId) {
            try {
                const textBytes = 2048 + ((item.text || '').length * 2); // UTF-8 worst-case 2 B/char
                const textTimeout = computeChunkTimeout(textBytes, measuredBps || null);
                await sendWithRetry(`${API_BASE}/reports/${reportId}/description`, {
                    description: item.text || ''
                }, 5, textTimeout);
                item.stages.text = true;
                try { await enqueueReport(item); } catch (_) {}
                console.log(`Stage 2 (text) sent (timeout=${textTimeout}ms)`);
            } catch (e) {
                console.warn('Stage 2 failed, will retry later:', e.message);
                // We DON'T return; we can still try to send media if we have a reportId
            }
        }

        // Stage 2: Photo — guaranteed-delivery tier ladder.
        //
        // The new pipeline uploads SMALL of every photo (main + extras)
        // BEFORE any MEDIUM; then MEDIUM of every photo; then LARGE. That
        // way responders see a complete usable image of every photo in the
        // shortest time physically possible on the current network,
        // instead of waiting for one full-quality LARGE before the next
        // photo starts.
        //
        // Legacy path (`item.photo` without variants) is preserved below
        // for reports queued before this feature shipped.
        if (!stages.photo && reportId) {
            try {
                // Build the variant work list, tier-first.
                const workUnits = _buildVariantWork(item);

                if (workUnits.length > 0) {
                    for (const unit of workUnits) {
                        if (unit.variant.complete) continue;
                        await _uploadVariantTier(item, reportId, unit);
                    }
                    // All variants done ⇒ stage photo complete.
                    const allComplete = workUnits.every(u => u.variant.complete);
                    if (allComplete) {
                        item.stages.photo = true;
                        // Clear variant payloads to free memory on retries/restart.
                        if (item.photoVariants) {
                            for (const t of ['small', 'medium', 'large']) {
                                item.photoVariants[t].dataUrl = null;
                            }
                        }
                        for (const ev of (item.extraPhotosVariants || [])) {
                            if (!ev) continue;
                            for (const t of ['small', 'medium', 'large']) {
                                ev[t].dataUrl = null;
                            }
                        }
                        item.photo = null;
                        item.extraPhotos = [];
                        try { await enqueueReport(item); } catch (_) {}
                        console.log('Photo + extras fully delivered (all variants)');
                    }
                } else if (item.photo) {
                    // Legacy single-photo path (no variants on this queue item).
                    await _uploadLegacyPhoto(item, reportId);
                }
            } catch (e) {
                console.warn(`Photo variant upload failed:`, e.message);
                try { await enqueueReport(item); } catch (_) {}
            }
        }

        // Stage 3: Audio — adaptive chunks
        if (!stages.audio && item.audioBlob && reportId) {
            try {
                const mediaId = item.audioMediaId || genUUID();
                item.audioMediaId = mediaId;

                detectPWANetworkTier();
                const netConfig = getPWAAdaptiveConfig();
                console.log(`[PWA Upload] Audio: tier=${_pwaTier}, chunkSize=${netConfig.chunkSize}`);

                const b64 = item.audioBlob.includes(',') ? item.audioBlob.split(',')[1] : item.audioBlob;
                const chunks = chunkBase64(b64, netConfig.chunkSize);
                const total = chunks.length;
                const startSeq = item.audioChunkProgress || 0;

                for (let seq = startSeq; seq < total; seq++) {
                    const chunkData = chunks[seq];
                    try {
                        await sendWithRetry(
                            `${API_BASE}/reports/${reportId}/media/chunk`,
                            {
                                media_id: mediaId,
                                type: 'AUDIO',
                                seq_num: seq,
                                total_chunks: total,
                                data: chunkData,
                                checksum: simpleChecksum(chunkData)
                            },
                            netConfig.retries, netConfig.timeout
                        );
                        pwaNetworkUpgrade();
                    } catch (retryErr) {
                        pwaNetworkDowngrade();
                        throw retryErr;
                    }
                    item.audioChunkProgress = seq + 1;
                    if ((seq + 1) % 5 === 0) {
                        try { await enqueueReport(item); } catch (_) {}
                    }
                }

                item.stages.audio = true;
                item.audioBlob = null;
                try { await enqueueReport(item); } catch (_) {}
                console.log(`Audio sent: ${total} chunks (tier=${_pwaTier})`);
            } catch (e) {
                console.warn(`Audio chunk failed at seq ${item.audioChunkProgress}:`, e.message);
                try { await enqueueReport(item); } catch (_) {}
            }
        }

        // All done?
        if (item.stages.meta && item.stages.text && item.stages.photo && item.stages.audio) {
            try { await dequeueReport(item.client_report_id); } catch (_) {}
            console.log('Report fully synced:', reportId);
        }
    } catch (e) {
        console.warn('trySendQueuedReport error:', e);
    } finally {
        // Always release the in-flight guard so the next retry-loop pass
        // can legitimately retry if this one didn't complete all stages.
        if (crid) _inFlightReports.delete(crid);
    }
    updateSyncBadge();
}

// ── Persistent Retry Loop — runs every 15 seconds ───────────────────────────
// This is the real workhorse. It keeps trying until everything is sent.
let _retryLoopRunning = false;
async function startRetryLoop() {
    if (_retryLoopRunning) return;
    _retryLoopRunning = true;
    console.log('Retry loop started');

    while (true) {
        try {
            // Hotfix (Apr 2026): BEFORE retrying uploads, reconcile against
            // server truth. If a report has already landed server-side but a
            // stage flag is still false locally (chunk ack lost, variant
            // accepted but response failed, etc.), purge it from the queue
            // so the retry loop stops pounding on already-received data.
            try { await _reconcileQueueAgainstServer(); } catch (_) {}

            const items = await getAllQueued();
            if (items.length === 0) {
                _retryLoopRunning = false;
                console.log('Retry loop: queue empty, stopping');
                return;
            }

            for (const rawItem of items) {
                // Backward-compat: unwrap old nested format (payload key) if present
                const item = rawItem.payload && !rawItem.stages ? rawItem.payload : rawItem;
                if (item.stages && item.meta) {
                    await trySendQueuedReport(item);
                }
            }
        } catch (e) {
            console.warn('Retry loop error:', e);
        }

        // Wait 15 seconds before next attempt
        await new Promise(r => setTimeout(r, 15000));
    }
}

function triggerBackgroundSync() {
    // Start persistent retry loop
    startRetryLoop();
    // Also try browser Background Sync API
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
        navigator.serviceWorker.ready.then(reg => {
            reg.sync.register('sync-reports').catch(() => {});
        });
    }
}

// Legacy syncQueue replaced by IndexedDB-based syncQueueManual (defined above)

function setupSendStage() {
    // Phase 6: stage-send may or may not exist (it's left in the DOM for
    // backward compat but the new flow doesn't navigate there). Guard every
    // DOM lookup so a missing element isn't fatal.
    const _bs = document.getElementById('btn-send');
    if (_bs) _bs.addEventListener('click', submitReport);
    const _bsb = document.getElementById('btn-send-back');
    if (_bsb) _bsb.addEventListener('click', () => goToStage('stage-review'));
    document.getElementById('btn-new-report').addEventListener('click', resetApp);

    // PR 7 (Apr 2026): Track button on the success screen. Opens the detail
    // view for the just-submitted report. openReportDetail() first looks in
    // _submittedCache; if the status-since poll hasn't fired yet, submitReport()
    // seeds a synthetic local row (see submitReport → _synthesizeSubmittedReport)
    // so the detail view has something to render immediately.
    const trackBtn = document.getElementById('btn-track-report');
    if (trackBtn) {
        trackBtn.addEventListener('click', () => {
            const id = _lastSubmittedClientId || _lastSubmittedServerId;
            if (!id) {
                if (typeof showToast === 'function') showToast(t('report_no_tracking'));
                return;
            }
            if (typeof window.openReportDetail === 'function') {
                window.openReportDetail(id);
            }
        });
    }

    // ── Phase 5 (Apr 2026) — PWA My Reports screen ─────────────────────────
    // Parity port of crisp-mobile/App.tsx:969–982 (history screen).
    // Three sections: In-flight (IndexedDB), Submitted (status-since),
    // Impact (aggregated lives_impacted).
    const _mrBtn = document.getElementById('btn-my-reports');
    const _mrBack = document.getElementById('btn-history-back');
    if (_mrBtn) _mrBtn.addEventListener('click', openMyReports);
    if (_mrBack) _mrBack.addEventListener('click', () => goToStage('stage-home'));
    // Back from detail view → return to history list. Re-render so any
    // queued-delete state reflects immediately.
    const _rdBack = document.getElementById('btn-rd-back');
    if (_rdBack) _rdBack.addEventListener('click', () => {
        goToStage('stage-history');
        _renderSubmittedReports().catch(() => {});
    });
    // Apr 2026 "My Reports" spec — try to flush any queued deletes from
    // prior offline sessions as soon as the user opens the app.
    setTimeout(() => { _syncDeleteQueue().catch(() => {}); }, 2000);

    // Apr 2026 UX rewrite — "Delete all my reports" moved from the landing
    // screen's Delete-My-Data panel INTO the history screen. Keeps data
    // management in one place. Wraps the existing purge-device endpoint.
    const _daBtn = document.getElementById('btn-history-delete-all');
    if (_daBtn) _daBtn.addEventListener('click', async () => {
        const deviceHash = localStorage.getItem('crisp_device_id_v2') ||
                           localStorage.getItem('crisp_device_hash') ||
                           localStorage.getItem('crisp_device_id') || '';
        if (!deviceHash) {
            showToast(t('delete_no_reports'), 'info');
            return;
        }
        if (!confirm(t('delete_all_confirm'))) return;
        _daBtn.disabled = true;
        _daBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t('delete_deleting')}`;
        try {
            const res = await fetch(`${API_BASE}/reports/device/${deviceHash}`, { method: 'DELETE' });
            if (res.ok) {
                showToast(t('delete_all_success'), 'success');
                // Refresh both history sections — they'll now show empty + the
                // home impact metrics will re-fetch next time home is entered.
                _renderPartialReports();
                _renderSubmittedReports();
            } else {
                let detail = `HTTP ${res.status}`;
                try { detail = (await res.json()).detail || detail; } catch (_) {}
                showToast(`Delete failed: ${detail}`, 'error');
            }
        } catch (e) {
            showToast(`Delete error: ${e.message}`, 'error');
        } finally {
            _daBtn.disabled = false;
            _daBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span data-i18n="delete_all_my_reports">Delete all my reports</span>';
        }
    });
}

async function openMyReports() {
    goToStage('stage-history');
    // Hotfix (Apr 2026): reconcile local IDB queue against server truth
    // BEFORE rendering. Fixes a class of bugs where a report reaches the
    // server successfully but one of the four client-side stage flags
    // (`meta`/`text`/`photo`/`audio`) never flipped true — usually because
    // the response body didn't return OK from a proxy, a chunk resumed
    // from a stale progress cursor, or a variant upload threw after the
    // server accepted the last chunk. The entry then sits in the
    // in-flight list forever at N% even though the dashboard shows it
    // fully received. The reconcile step takes server state as source of
    // truth: if the server knows about this client_report_id, purge the
    // local queue entry.
    await _reconcileQueueAgainstServer();
    await Promise.all([_renderPartialReports(), _renderSubmittedReports()]);
}

/**
 * Dequeue any IDB entry whose `client_report_id` is known to the server.
 * Safe: server sees the report in its authoritative list, so the client's
 * in-flight view is redundant. Called from openMyReports + the retry loop.
 * No-op if the device has no hash (no reports ever submitted) or the
 * status-since endpoint is unreachable (offline — keep everything queued).
 */
async function _reconcileQueueAgainstServer() {
    const deviceHash = _deviceHashForHistory();
    if (!deviceHash) return;
    let serverReports = [];
    try {
        const res = await fetch(`${API_BASE}/reports/device/${deviceHash}/status-since?since=1970-01-01T00:00:00Z`);
        if (!res.ok) return;
        serverReports = await res.json();
    } catch (_) {
        // Offline / backend down — do NOT dequeue; upload still pending.
        return;
    }
    if (!Array.isArray(serverReports) || serverReports.length === 0) return;
    // Index by client_report_id for O(1) lookup.
    const serverIds = new Set();
    const serverRowById = new Map();
    for (const r of serverReports) {
        if (r.client_report_id) {
            serverIds.add(r.client_report_id);
            serverRowById.set(r.client_report_id, r);
        }
    }
    let queued = [];
    try {
        queued = await getAllQueued();
    } catch (_) {
        return;
    }
    for (const item of queued) {
        if (!item.client_report_id) continue;
        if (!serverIds.has(item.client_report_id)) continue;
        // Safety check: only dequeue if the server has received at least
        // as many media as the client expected. If the server row is
        // missing media, keep the item queued so retries can finish the
        // upload. When the client sent no media (text-only report), we
        // treat an existing server row as sufficient to dequeue.
        const srv = serverRowById.get(item.client_report_id);
        const expected = (item.meta && typeof item.meta.expected_media === 'number')
            ? item.meta.expected_media
            : 0;
        const have = Array.isArray(srv.media) ? srv.media.length : 0;
        if (expected > 0 && have < expected) {
            console.log(`[Reconcile] ${item.client_report_id.slice(0, 8)}: server has ${have}/${expected} media — keep queued to finish upload`);
            continue;
        }
        try {
            await dequeueReport(item.client_report_id);
            console.log(`[Reconcile] dequeued ${item.client_report_id.slice(0, 8)} — server has it (${have}/${expected} media)`);
        } catch (e) {
            console.warn('[Reconcile] dequeue failed:', e);
        }
    }
    updateSyncBadge();
}

function _deviceHashForHistory() {
    // PWA assigns a device_hash on first capture and stores it in localStorage.
    // `crisp_device_id_v2` is the CURRENT key (SHA-256-based stable anonymous
    // id written by submitReport). Older users may have `crisp_device_hash`
    // or `crisp_device_id` — keep those as fallbacks so their history still
    // resolves post-migration.
    //
    // HOTFIX (Apr 2026): was previously reading only the legacy keys, which
    // caused submitted reports to disappear from "My Reports" because the
    // server's status-since lookup used the wrong hash.
    return localStorage.getItem('crisp_device_id_v2') ||
           localStorage.getItem('crisp_device_hash') ||
           localStorage.getItem('crisp_device_id') || '';
}

function _historyEmpty(container, text, icon) {
    container.innerHTML = `<div class="history-empty">
        <i class="fa-solid ${icon}"></i>
        <p>${text}</p>
    </div>`;
}

async function _renderPartialReports() {
    const list = document.getElementById('history-partial-list');
    if (!list) return;
    let items = [];
    try {
        items = await getAllQueued();
    } catch (e) {
        console.warn('[MyReports] IDB read failed:', e);
    }
    // Only show reports that haven't fully synced. All stages complete = done.
    const inflight = items.filter((it) => {
        const st = it.stages || {};
        return !(st.meta && st.photo && st.audio && st.text);
    });
    if (!inflight.length) {
        _historyEmpty(list, t('empty_in_flight'), 'fa-cloud-check');
        return;
    }
    list.innerHTML = inflight.map((it) => {
        const pct = _inflightPct(it);
        const status = it.status || 'queued';
        const statusChip = status === 'failed'
            ? `<span class="hr-chip hr-chip-fail">${t('status_failed')}</span>`
            : status === 'syncing' ? `<span class="hr-chip hr-chip-sync">${t('status_uploading')}</span>`
            : `<span class="hr-chip hr-chip-queue">${t('status_queued')}</span>`;
        const crisis = (it.meta && it.meta.crisis_type) || '—';
        const infra = (it.meta && it.meta.infrastructure_type) || '—';
        return `<div class="history-row">
            <div class="hr-top">
                <span class="hr-title">${escapeHtmlSimple(crisis)} · ${escapeHtmlSimple(infra)}</span>
                ${statusChip}
            </div>
            <div class="hr-progress-track"><div class="hr-progress-fill" style="width:${pct}%"></div></div>
            <div class="hr-meta">${pct}% · ${it.client_report_id.slice(0, 8)}</div>
        </div>`;
    }).join('');
}

function _inflightPct(item) {
    const st = item.stages || {};
    const total = 4;
    const done = (st.meta ? 1 : 0) + (st.photo ? 1 : 0) + (st.audio ? 1 : 0) + (st.text ? 1 : 0);
    return Math.round((done / total) * 100);
}

// ── Apr 2026 "My Reports" spec — shared helpers ───────────────────────────
// Map the backend's two orthogonal fields (`status` enum + `reviewer_verdict`)
// to a single 4-state user-facing view.
//
//   state | color  | meaning
//   ------|--------|-----------------------------------------------
//   SUBMITTED    | grey   | Sent, not yet reviewed
//   UNDER_REVIEW | yellow | Reviewer assessing / responder dispatched
//   ACCEPTED     | green  | Verdict=ACCEPTED (responder may or may not have moved yet)
//   REJECTED     | red    | Verdict=REJECTED OR status=FALSE_ALARM
//
// Rule (user-locked): verdict-first. A backend status of RESOLVED with
// verdict=ACCEPTED stays green. Verdict=NOT_REVIEWED with status=RESPONDING
// becomes "Under Review" because the responder is working on it.
function _mapReportStatus(r) {
    const verdict = r.reviewer_verdict || 'NOT_REVIEWED';
    const status = (r.status || 'PENDING').toUpperCase();
    if (verdict === 'ACCEPTED') {
        return { state: 'ACCEPTED', color: '#22c55e', icon: '🟢', label: t('rd_status_accepted') };
    }
    if (verdict === 'REJECTED' || status === 'FALSE_ALARM') {
        return { state: 'REJECTED', color: '#ef4444', icon: '🔴', label: t('rd_status_rejected') };
    }
    if (status === 'RESPONDING') {
        return { state: 'UNDER_REVIEW', color: '#eab308', icon: '🟡', label: t('rd_status_under_review') };
    }
    return { state: 'SUBMITTED', color: '#9ca3af', icon: '⚪', label: t('rd_status_submitted') };
}

// Derive the "Action taken" sentence shown on the detail view. Spec:
// auto-derive from timestamps + verdict; if the analyst also typed
// free-text in action_taken, append it.
function _deriveActionTaken(r) {
    const lines = [];
    if (r.help_arrived_at) {
        lines.push(t('rd_action_help_arrived'));
    } else if (r.help_dispatched_at) {
        lines.push(t('rd_action_help_dispatched'));
    } else if ((r.reviewer_verdict || '') === 'ACCEPTED') {
        lines.push(t('rd_feedback_awaiting'));
    }
    if ((r.reviewer_verdict || '') === 'ACCEPTED' && r.action_taken && r.action_taken.trim()) {
        // User-authored free-text from a reviewer — stored verbatim; NOT
        // translated (matches policy for user-generated content).
        lines.push(r.action_taken.trim());
    }
    return lines;
}

// Short-form time display for the card — "2 days ago", "5 min ago", etc.
// The `t(key).replace('{n}', n)` pattern is our light-weight interpolation;
// a real ICU message formatter would handle plural forms natively, but for
// "N min ago" strings this is sufficient across the locales we support.
function _timeAgo(iso) {
    if (!iso) return '';
    const ts = new Date(iso).getTime();
    if (!Number.isFinite(ts)) return '';
    const diff = Math.max(0, (Date.now() - ts) / 1000);
    const fmt = (key, n) => t(key).replace('{n}', String(n));
    if (diff < 60) return fmt('time_seconds_ago', Math.round(diff));
    if (diff < 3600) return fmt('time_minutes_ago', Math.round(diff / 60));
    if (diff < 86400) return fmt('time_hours_ago', Math.round(diff / 3600));
    const days = Math.round(diff / 86400);
    if (days === 1) return t('time_1_day_ago');
    if (days < 30) return fmt('time_days_ago', days);
    const months = Math.floor(days / 30);
    return months === 1 ? t('time_1_month_ago') : fmt('time_months_ago', months);
}

// Cache so the detail view can hydrate instantly without another fetch.
let _submittedCache = [];

// PR 7 (Apr 2026): remember the just-submitted report so the success screen's
// Track button can open its detail view even before the status-since poll
// has refreshed _submittedCache. Cleared on resetApp() / fresh submit.
let _lastSubmittedClientId = null;
let _lastSubmittedServerId = null;

/**
 * Synthesise a minimal report row from the current submit state and prepend it
 * to _submittedCache. The record is overwritten by the next status-since poll
 * that brings back the real server view; until then the detail page at least
 * has something to render instead of a "not found" toast.
 */
function _synthesizeSubmittedReport(clientReportId, extra) {
    const nowIso = new Date().toISOString();
    const synth = {
        id: (extra && extra.serverId) || null,
        client_report_id: clientReportId,
        server_created_at: nowIso,
        updated_at: nowIso,
        infrastructure_type: state.infraType,
        crisis_type: state.crisisType,
        severity: state.severity,
        damage_classification: state.damageClass,
        description: state.description || '',
        location_name: state.locationName || (state.userLocationName || null),
        latitude: state.location?.lat || null,
        longitude: state.location?.lng || null,
        verdict: 'NOT_REVIEWED',
        status: 'SUBMITTED',
        photo_group_id: state.photoGroupId || null,
        __synthetic: true,  // debugging flag; ignored by renderReportDetail
    };
    // Prepend so it's the first item the cache lookup finds.
    _submittedCache = [synth, ...(_submittedCache || []).filter(r =>
        r.client_report_id !== clientReportId && r.id !== (extra && extra.serverId)
    )];
    _lastSubmittedClientId = clientReportId;
    if (extra && extra.serverId) _lastSubmittedServerId = extra.serverId;
}
// Testability hook: PR 7 spec seeds the cache + last-submitted pointer so
// the Track button's open-detail path can be exercised without a real submit.
window.__crispSynthesizeSubmittedReport = _synthesizeSubmittedReport;

async function _renderSubmittedReports() {
    const list = document.getElementById('history-synced-list');
    const impactCard = document.getElementById('history-impact-card');
    if (!list) return;
    const deviceHash = _deviceHashForHistory();
    if (!deviceHash) {
        _historyEmpty(list, t('empty_submitted'), 'fa-paper-plane');
        if (impactCard) impactCard.style.display = 'none';
        return;
    }
    let reports = [];
    try {
        const res = await fetch(`${API_BASE}/reports/device/${deviceHash}/status-since?since=1970-01-01T00:00:00Z`);
        if (res.ok) reports = await res.json();
    } catch (e) {
        console.warn('[MyReports] status-since failed:', e);
    }
    // Phase 5e (Apr 2026) — celebratory delta notification. Compare each
    // report to the snapshot we saved last time My Reports was opened:
    //  - verdict NOT_REVIEWED → ACCEPTED       → "🎉 Your report was accepted!"
    //  - lives_impacted went up                 → "💚 You helped N more lives"
    // Snapshot is keyed by client_report_id so a new report doesn't trigger
    // a false positive on the first visit.
    try {
        const snapRaw = localStorage.getItem('crisp_mr_snapshot_v1');
        const snap = snapRaw ? JSON.parse(snapRaw) : {};
        let acceptedN = 0;
        let livesDelta = 0;
        for (const r of reports) {
            const prev = snap[r.client_report_id];
            if (prev) {
                if (prev.verdict !== 'ACCEPTED' && r.reviewer_verdict === 'ACCEPTED') acceptedN++;
                const prevL = Number.isFinite(prev.lives) ? prev.lives : 0;
                const nowL = Number.isFinite(r.lives_impacted) ? r.lives_impacted : 0;
                if (nowL > prevL) livesDelta += (nowL - prevL);
            }
        }
        // Update snapshot for next open.
        const next = {};
        for (const r of reports) {
            next[r.client_report_id] = {
                verdict: r.reviewer_verdict || 'NOT_REVIEWED',
                lives: Number.isFinite(r.lives_impacted) ? r.lives_impacted : 0,
            };
        }
        try { localStorage.setItem('crisp_mr_snapshot_v1', JSON.stringify(next)); } catch (_) {}
        // Emit toasts (only if we had a prior snapshot — i.e. not first visit).
        if (snapRaw) {
            if (acceptedN > 0) {
                _showCelebration(`🎉 ${acceptedN} report${acceptedN > 1 ? 's' : ''} accepted — thank you for reporting!`);
            }
            if (livesDelta > 0) {
                _showCelebration(`💚 Your reports helped ${livesDelta} more ${livesDelta > 1 ? 'lives' : 'life'}!`);
            }
        }
    } catch (e) {
        console.warn('[MyReports] delta check failed:', e);
    }
    // Impact summary.
    const resolved = reports.filter(r => r.status === 'RESOLVED').length;
    const livesTotal = reports.reduce((n, r) => n + (Number.isFinite(r.lives_impacted) ? r.lives_impacted : 0), 0);
    const inflightCount = document.querySelectorAll('#history-partial-list .history-row').length;
    if (impactCard) {
        document.getElementById('hi-resolved').textContent = String(resolved);
        document.getElementById('hi-lives').textContent = String(livesTotal);
        document.getElementById('hi-pending').textContent = String(inflightCount);
        impactCard.style.display = 'flex';
    }
    // Update the home-screen badge.
    const mrLives = document.getElementById('mr-lives-badge');
    if (mrLives) {
        if (livesTotal > 0) {
            mrLives.textContent = `💚 ${livesTotal} lives`;
            mrLives.style.display = 'inline-block';
        } else {
            mrLives.style.display = 'none';
        }
    }
    if (!reports.length) {
        _historyEmpty(list, t('empty_submitted'), 'fa-paper-plane');
        return;
    }
    // Apr 2026 "My Reports" spec — cards show thumbnail + location + date
    // + single colored status chip. Tapping a card opens the detail view.
    // Data for the detail view is cached in _submittedCache so the tap
    // doesn't round-trip to the server again.
    _submittedCache = reports.slice();

    list.innerHTML = reports.map((r) => {
        const st = _mapReportStatus(r);
        const loc = r.location || {};
        const placeName = loc.user_location_name || loc.device_location_name ||
            (Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)
                ? `${loc.latitude.toFixed(3)}°, ${loc.longitude.toFixed(3)}°`
                : '');
        // Lazy-loaded thumbnail (loading="lazy") — large lists don't pay
        // the download cost until the card scrolls into view.
        const thumbUrl = r.thumbnail_url
            ? (r.thumbnail_url.startsWith('http') ? r.thumbnail_url
               : `${_backendHost}${r.thumbnail_url.startsWith('/') ? '' : '/'}${r.thumbnail_url}`)
            : '';
        const thumbHtml = thumbUrl
            ? `<img class="mr-card-thumb" src="${escapeHtmlSimple(thumbUrl)}" alt="Report photo" loading="lazy">`
            : `<div class="mr-card-thumb mr-card-thumb-placeholder"><i class="fa-solid fa-camera"></i></div>`;
        const dateText = _timeAgo(r.server_created_at || r.updated_at);
        // Apr 2026: "N lives" string now translated. Uses one-/many-
        // plural keys (reusing the report-detail rd_people_helped_* pack).
        const lives = Number.isFinite(r.lives_impacted) && r.lives_impacted > 0
            ? `<span class="mr-card-lives">💚 ${escapeHtmlSimple(
                (r.lives_impacted === 1 ? t('rd_people_helped_one') : t('rd_people_helped_many'))
                    .replace('{n}', String(r.lives_impacted)))}</span>`
            : '';
        // Queued-delete indicator — set when the user deleted offline.
        const pendingDelete = _isDeleteQueued(r.id || r.client_report_id)
            ? `<div class="mr-card-pending"><i class="fa-solid fa-clock-rotate-left"></i> ${escapeHtmlSimple(t('rd_delete_queued'))}</div>`
            : '';
        // Apr 2026: translate enum values in the card title. Maps crisis /
        // infrastructure keys (lowercase) via the same translateEnum helper
        // used in renderReportDetail. Falls back to a prettified raw enum
        // when no i18n key exists (e.g. a newly-added crisis type before
        // translators catch up). Raw "WILDFIRE · HOSPITAL" becomes the
        // native-language equivalent: "جنگل کی آگ · ہسپتال" in Urdu.
        const _translateEnum = (raw, keyFn) => {
            if (!raw) return '—';
            const k = keyFn(raw);
            const en = I18N.en || {};
            const locale = I18N[state.lang] || {};
            if (Object.prototype.hasOwnProperty.call(locale, k)) return locale[k];
            if (Object.prototype.hasOwnProperty.call(en, k)) return en[k];
            return String(raw).replace(/_/g, ' ').toLowerCase()
                .replace(/^\w/, (c) => c.toUpperCase());
        };
        const crisisStr = _translateEnum(r.crisis_type, (x) => String(x).toLowerCase());
        const infraStr = _translateEnum(r.infrastructure_type, (x) => String(x).toLowerCase());
        const title = crisisStr + ' · ' + infraStr;
        return `<button class="mr-card" type="button" data-report-id="${escapeHtmlSimple(r.id || r.client_report_id)}">
            ${thumbHtml}
            <div class="mr-card-body">
                <div class="mr-card-top">
                    <span class="mr-card-title">${escapeHtmlSimple(title)}</span>
                    <span class="mr-status-chip mr-status-${st.state.toLowerCase()}">${st.icon} ${st.label}</span>
                </div>
                <div class="mr-card-meta">
                    ${placeName ? `<span><i class="fa-solid fa-location-dot"></i> ${escapeHtmlSimple(placeName)}</span>` : ''}
                    ${dateText ? `<span><i class="fa-regular fa-clock"></i> ${dateText}</span>` : ''}
                    ${lives}
                </div>
                ${pendingDelete}
            </div>
        </button>`;
    }).join('');

    // Attach click handlers to open the detail view. Using event delegation
    // would be slightly cheaper but direct binding is clearer for N<100.
    list.querySelectorAll('.mr-card').forEach((el) => {
        const id = el.getAttribute('data-report-id');
        el.addEventListener('click', () => openReportDetail(id));
    });
}

function _fmtSecs(s) {
    if (!Number.isFinite(s) || s < 0) return '';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function escapeHtmlSimple(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Apr 2026 "My Reports" spec — individual report detail + delete ─────────

const _DELETE_QUEUE_KEY = 'crisp_report_delete_queue_v1';

/** Return true if this report ID or client_report_id is queued for delete
 *  (user deleted while offline; sync pending). */
function _isDeleteQueued(id) {
    try {
        const raw = localStorage.getItem(_DELETE_QUEUE_KEY);
        if (!raw) return false;
        const q = JSON.parse(raw);
        return Array.isArray(q) && q.some(entry => entry.id === id || entry.clientReportId === id);
    } catch { return false; }
}

/** Add a delete request to the offline queue. De-duplicated on id. */
function _enqueueDelete(entry) {
    let q = [];
    try {
        const raw = localStorage.getItem(_DELETE_QUEUE_KEY);
        if (raw) q = JSON.parse(raw) || [];
    } catch { q = []; }
    if (!q.some(e => e.id === entry.id)) q.push(entry);
    try { localStorage.setItem(_DELETE_QUEUE_KEY, JSON.stringify(q)); } catch(_) {}
}

/** Remove a successfully-synced delete from the queue. */
function _dequeueDelete(id) {
    try {
        const raw = localStorage.getItem(_DELETE_QUEUE_KEY);
        if (!raw) return;
        const q = (JSON.parse(raw) || []).filter(e => e.id !== id);
        localStorage.setItem(_DELETE_QUEUE_KEY, JSON.stringify(q));
    } catch(_) {}
}

/** Flush queued deletes when the network comes back. Idempotent — safe
 *  to call on every 'online' event + on app boot. */
async function _syncDeleteQueue() {
    let q = [];
    try {
        const raw = localStorage.getItem(_DELETE_QUEUE_KEY);
        if (raw) q = JSON.parse(raw) || [];
    } catch { return; }
    if (!q.length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    for (const entry of q.slice()) {
        try {
            const res = await fetch(`${API_BASE}/reports/${entry.id}`, { method: 'DELETE' });
            // 200/204 = success; 404 = already gone (server purged) — both OK.
            if (res.ok || res.status === 204 || res.status === 404) {
                _dequeueDelete(entry.id);
            }
        } catch (e) {
            console.warn('[DeleteQueue] sync failed:', entry.id, e);
            // Leave in the queue; retry next time.
        }
    }
}

// Sync on boot + every time the tab regains connectivity.
window.addEventListener('online', () => { _syncDeleteQueue().catch(() => {}); });

/** Open the detail view for a report. Populates stage-report-detail from
 *  the submitted-cache (populated by _renderSubmittedReports). */
window.openReportDetail = async function (id) {
    // Try cache first, then fall back to fetching the full list again.
    let report = _submittedCache.find(r => r.id === id || r.client_report_id === id);
    if (!report) {
        const deviceHash = _deviceHashForHistory();
        if (deviceHash) {
            try {
                const res = await fetch(`${API_BASE}/reports/device/${deviceHash}/status-since?since=1970-01-01T00:00:00Z`);
                if (res.ok) {
                    const arr = await res.json();
                    _submittedCache = arr;
                    report = arr.find(r => r.id === id || r.client_report_id === id);
                }
            } catch(_) {}
        }
    }
    if (!report) {
        showToast(t('report_not_found'), 'error');
        return;
    }
    renderReportDetail(report);
    goToStage('stage-report-detail');
};

/** Render the detail view. Pure DOM mutation — no state changes. */
function renderReportDetail(r) {
    // Stash the last-rendered report so applyI18n() can re-invoke on
    // language change without needing to re-fetch.
    _lastRenderedReport = r;
    const st = _mapReportStatus(r);

    // Status chip
    const chip = document.getElementById('rd-status-chip');
    if (chip) {
        chip.className = `rd-status-chip mr-status-${st.state.toLowerCase()}`;
        chip.textContent = `${st.icon} ${st.label}`;
    }

    // Date sub-meta
    const dateMeta = document.getElementById('rd-meta-date');
    if (dateMeta) {
        const iso = r.server_created_at || r.updated_at;
        dateMeta.textContent = iso ? new Date(iso).toLocaleString() : '';
    }

    // Timeline — 4 stops: Submitted → Under Review → Accepted → Help Sent.
    // Done vs upcoming is derived from timestamps so the visual always
    // matches the canonical backend state.
    const tl = document.getElementById('rd-timeline');
    if (tl) {
        const submitted = !!r.server_created_at;
        const reviewed = !!r.reviewed_at;
        const accepted = (r.reviewer_verdict || '') === 'ACCEPTED';
        const rejected = (r.reviewer_verdict || '') === 'REJECTED' ||
            (r.status || '').toUpperCase() === 'FALSE_ALARM';
        const dispatched = !!r.help_dispatched_at;
        const steps = [
            { key: 'submitted', label: t('rd_tl_submitted'), done: submitted },
            { key: 'review', label: t('rd_tl_review'), done: reviewed || dispatched || accepted || rejected },
            {
                key: 'verdict',
                label: rejected ? t('rd_tl_rejected') : t('rd_tl_accepted'),
                done: accepted || rejected,
                rejected,
            },
            { key: 'help', label: t('rd_tl_help_sent'), done: dispatched || !!r.help_arrived_at, hidden: rejected },
        ];
        tl.innerHTML = steps.filter(s => !s.hidden).map((s, i, arr) => {
            const cls = s.done
                ? (s.rejected ? 'rd-tl-rejected' : 'rd-tl-done')
                : 'rd-tl-upcoming';
            const line = i < arr.length - 1 ? '<div class="rd-tl-line"></div>' : '';
            return `<div class="rd-tl-step ${cls}">
                <div class="rd-tl-dot"></div>
                <div class="rd-tl-label">${escapeHtmlSimple(s.label)}</div>
            </div>${line}`;
        }).join('');
    }

    // Photo (fallback to placeholder)
    const photoWrap = document.getElementById('rd-photo-wrap');
    const photo = document.getElementById('rd-photo');
    if (photoWrap && photo) {
        const url = r.thumbnail_url
            ? (r.thumbnail_url.startsWith('http') ? r.thumbnail_url
                : `${_backendHost}${r.thumbnail_url.startsWith('/') ? '' : '/'}${r.thumbnail_url}`)
            : '';
        if (url) {
            photo.src = url;
            photoWrap.style.display = '';
            photo.onclick = () => {
                if (typeof window.openLightbox === 'function') {
                    window.openLightbox(url, 'Report photo');
                }
            };
        } else {
            photoWrap.style.display = 'none';
        }
    }

    // Description
    const descSection = document.getElementById('rd-desc-section');
    const desc = document.getElementById('rd-desc');
    if (descSection && desc) {
        if (r.description && r.description.trim()) {
            desc.textContent = r.description;
            descSection.style.display = '';
        } else {
            descSection.style.display = 'none';
        }
    }

    // Metadata grid — labels translated; values are enum names (we also
    // translate those via lowercase-key lookup when a match exists, otherwise
    // show the raw enum with underscores replaced so the user still gets the
    // info — e.g. "WILDFIRE" → "Wildfire" / "ಕಾಳ್ಗಿಚ್ಚು").
    const grid = document.getElementById('rd-meta-grid');
    if (grid) {
        const loc = r.location || {};
        const placeName = loc.user_location_name || loc.device_location_name;
        // Translate enum values where we have a matching i18n key (lowercase).
        // Crisis enums like WILDFIRE → key `wildfire`; infra like HOSPITAL →
        // `hospital`; damage like COMPLETE → `complete_damage`; severity like
        // SEVERE → `severe`. Fall back to titlecased raw value if no key.
        const translateEnum = (raw, keyFn) => {
            if (!raw) return '';
            const k = keyFn(raw);
            const en = I18N.en || {};
            const locale = I18N[state.lang] || {};
            if (Object.prototype.hasOwnProperty.call(locale, k)) return locale[k];
            if (Object.prototype.hasOwnProperty.call(en, k)) return en[k];
            // Fallback: prettify the raw enum.
            return String(raw).replace(/_/g, ' ').toLowerCase()
                .replace(/^\w/, (c) => c.toUpperCase());
        };
        const entries = [];
        if (placeName) entries.push({ icon: 'fa-location-dot', label: t('rd_meta_location'), value: placeName });
        if (r.crisis_type) entries.push({ icon: 'fa-cloud-bolt', label: t('rd_meta_crisis'), value: translateEnum(r.crisis_type, (x) => String(x).toLowerCase()) });
        if (r.infrastructure_type) entries.push({ icon: 'fa-building', label: t('rd_meta_what'), value: translateEnum(r.infrastructure_type, (x) => String(x).toLowerCase()) });
        if (r.damage_classification) entries.push({ icon: 'fa-building-circle-xmark', label: t('rd_meta_damage'), value: translateEnum(r.damage_classification, (x) => {
            // DAMAGE enum → damage-i18n-key mapping. UNDP Appendix-1 uses
            // MINIMAL / PARTIAL / COMPLETE; legacy NO_DAMAGE kept as an
            // inbound alias so reports stored before the April-2026 rename
            // still render sensibly.
            const s = String(x).toUpperCase();
            if (s === 'MINIMAL' || s === 'NO_DAMAGE') return 'minimal_damage';
            if (s === 'PARTIAL') return 'partial_damage';
            if (s === 'COMPLETE') return 'complete_damage';
            return String(x).toLowerCase();
        }) });
        if (r.severity) entries.push({ icon: 'fa-triangle-exclamation', label: t('rd_meta_severity'), value: translateEnum(r.severity, (x) => String(x).toLowerCase()) });
        grid.innerHTML = entries.map(e => `<div class="rd-meta-item">
            <i class="fa-solid ${e.icon}"></i>
            <div><div class="rd-meta-label">${escapeHtmlSimple(e.label)}</div>
            <div class="rd-meta-value">${escapeHtmlSimple(e.value)}</div></div>
        </div>`).join('') || `<div style="color:#94a3b8;font-size:12px;">${escapeHtmlSimple(t('rd_no_details'))}</div>`;
    }

    // Feedback (green block) — only when accepted.
    const fb = document.getElementById('rd-feedback');
    const fbTitle = document.getElementById('rd-feedback-title');
    const fbSub = document.getElementById('rd-feedback-sub');
    if (fb && fbTitle && fbSub) {
        if (st.state === 'ACCEPTED') {
            const actions = _deriveActionTaken(r);
            fbTitle.textContent = t('rd_feedback_accepted_title');
            const parts = [];
            if (actions.length) parts.push(actions.join(' · '));
            if (Number.isFinite(r.lives_impacted) && r.lives_impacted > 0) {
                const key = r.lives_impacted === 1 ? 'rd_people_helped_one' : 'rd_people_helped_many';
                parts.push(t(key).replace('{n}', String(r.lives_impacted)));
            }
            fbSub.textContent = parts.join(' · ') || t('rd_feedback_awaiting');
            fb.style.display = '';
        } else {
            fb.style.display = 'none';
        }
    }

    // Rejection reason — `action_taken` is reviewer-authored free text,
    // stored verbatim and NOT translated (matches user-generated content
    // policy). Fall back to a localized default when no text exists.
    const rej = document.getElementById('rd-rejection');
    const rejText = document.getElementById('rd-rejection-text');
    if (rej && rejText) {
        if (st.state === 'REJECTED') {
            rejText.textContent = r.action_taken || t('rd_rejection_default');
            rej.style.display = '';
        } else {
            rej.style.display = 'none';
        }
    }

    // Delete button / queued state
    const delRow = document.getElementById('rd-delete-row');
    const delBtn = document.getElementById('btn-rd-delete');
    const delNote = document.getElementById('rd-delete-note');
    if (delRow && delBtn && delNote) {
        const id = r.id || r.client_report_id;
        const queued = _isDeleteQueued(id);
        const alreadyRequested = !!r.deletion_requested_at;
        if (alreadyRequested) {
            delBtn.style.display = 'none';
            delNote.style.display = '';
            delNote.textContent = t('rd_delete_in_progress');
        } else if (queued) {
            delBtn.style.display = 'none';
            delNote.style.display = '';
            delNote.textContent = t('rd_delete_queued');
        } else {
            delBtn.style.display = '';
            delNote.style.display = 'none';
            // Re-bind so closures capture the CURRENT report, not the
            // previous one the stage was showing.
            delBtn.onclick = () => confirmDeleteReport(r);
        }
    }
}

/** Confirm + delete flow. Falls back to the offline queue when fetch fails. */
async function confirmDeleteReport(r) {
    if (!confirm(t('rd_delete_confirm_prompt'))) return;
    const id = r.id || r.client_report_id;
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            _enqueueDelete({ id, clientReportId: r.client_report_id, queuedAt: Date.now() });
            showToast(t('rd_delete_queued'), 'info');
            renderReportDetail({ ...r, deletion_requested_at: null });  // re-render to show queued state
            // Force the pending state on the screen we're on:
            const delNote = document.getElementById('rd-delete-note');
            const delBtn = document.getElementById('btn-rd-delete');
            if (delBtn && delNote) {
                delBtn.style.display = 'none';
                delNote.style.display = '';
                delNote.textContent = 'Will be deleted when connected.';
            }
            return;
        }
        const res = await fetch(`${API_BASE}/reports/${id}`, { method: 'DELETE' });
        if (res.ok || res.status === 204) {
            showToast(t('delete_requested_toast'), 'success');
            // Flip local state so subsequent screens show the "pending" note.
            renderReportDetail({ ...r, deletion_requested_at: new Date().toISOString() });
            // Refresh the list on the way back.
            setTimeout(() => { _renderSubmittedReports().catch(() => {}); }, 500);
        } else if (res.status === 404) {
            // Already gone on the server; treat as success.
            showToast(t('delete_already_removed'), 'info');
            setTimeout(() => { _renderSubmittedReports().catch(() => {}); }, 500);
        } else {
            throw new Error(`HTTP ${res.status}`);
        }
    } catch (e) {
        // Likely network failure — enqueue and leave a clear note.
        console.warn('[Delete] failed, queueing:', e);
        _enqueueDelete({ id, clientReportId: r.client_report_id, queuedAt: Date.now() });
        showToast(t('delete_offline_queued'), 'info');
        const delNote = document.getElementById('rd-delete-note');
        const delBtn = document.getElementById('btn-rd-delete');
        if (delBtn && delNote) {
            delBtn.style.display = 'none';
            delNote.style.display = '';
            delNote.textContent = 'Will be deleted when connected.';
        }
    }
}

/** Phase 5e — green celebratory toast. Stacks cleanly if multiple fire. */
function _showCelebration(message) {
    const host = (() => {
        let el = document.getElementById('celebration-stack');
        if (!el) {
            el = document.createElement('div');
            el.id = 'celebration-stack';
            el.style.cssText = 'position:fixed;top:72px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:9998;pointer-events:none;max-width:90vw;';
            document.body.appendChild(el);
        }
        return el;
    })();
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'background:linear-gradient(90deg,#16a34a,#22c55e);color:#fff;padding:10px 16px;border-radius:999px;font-size:13px;font-weight:700;box-shadow:0 6px 16px rgba(34,197,94,0.35);white-space:nowrap;opacity:0;transform:translateY(-6px);transition:opacity .3s, transform .3s;';
    host.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-6px)';
        setTimeout(() => toast.remove(), 350);
    }, 3200);
}

// ── Gamification Badge Fetch ─────────────────────────────────────────────────
async function fetchBadge(deviceHash) {
    // Skip cleanly when offline — no console noise mid-flow.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
        const res = await fetch(`${API_BASE}/reports/profile/${deviceHash}`);
        if (!res.ok) return;
        const p = await res.json();
        const badges = { NEWCOMER: '🌱', HELPER: '🤝', GUARDIAN: '🛡', HERO: '🦸' };
        const tiers = [
            { level: 'NEWCOMER', need: 1, next: 'Helper', nextNeed: 3 },
            { level: 'HELPER', need: 3, next: 'Guardian', nextNeed: 10 },
            { level: 'GUARDIAN', need: 10, next: 'Hero', nextNeed: 25 },
            { level: 'HERO', need: 25, next: null, nextNeed: 25 },
        ];
        const tier = tiers.find(t => t.level === p.badge_level) || tiers[0];
        const pct = tier.next ? Math.min(100, Math.round((p.report_count / tier.nextNeed) * 100)) : 100;

        const card = document.getElementById('badge-card');
        if (card) {
            document.getElementById('badge-icon').textContent = badges[p.badge_level] || '🌱';
            document.getElementById('badge-level').textContent = p.badge_level.charAt(0) + p.badge_level.slice(1).toLowerCase();
            document.getElementById('badge-count').textContent = `${p.report_count} report${p.report_count !== 1 ? 's' : ''} submitted`;
            document.getElementById('badge-bar-fill').style.width = pct + '%';
            document.getElementById('badge-next').textContent = tier.next ? `Next: ${tier.next} (${tier.nextNeed} reports)` : 'Max level reached!';
            card.style.display = 'flex';
        }
    } catch (_) {}
}

// ── Toast Notification ────────────────────────────────────────────────────────
function showToast(message, duration = 3000) {
    const existingToast = document.getElementById('toast-notification');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.style.cssText = `
        position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.9); color: #fff;
        padding: 12px 20px; border-radius: 20px;
        font-size: 0.95rem; z-index: 300;
        animation: slideUp 0.3s ease-out;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideDown 0.3s ease-in';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ─── Capture-state reset ────────────────────────────────────────────────────
// Field-report bug (Apr 2026): after a successful submit, the user reported
// the next capture flow showed the PREVIOUS report's photo and text until
// they hard-refreshed. Root cause: `resetApp()` was only wired to the
// "Add another report" button on the success screen. Users who navigated
// away by any other route (My Reports → Home, browser back, service-worker
// refresh, IndexedDB sync-on-boot then btn-start) would land on stage-photo
// with stale `state.*` and — crucially — with `<img>.src` still pointing at
// the previous photo's data URL.
//
// Fix has two halves:
//   1. Split reset into `_clearCaptureState()` (pure, no navigation) +
//      `resetApp()` (calls _clearCaptureState + goToStage('stage-home')).
//   2. Call `_clearCaptureState()` immediately after a successful enqueue
//      (see submitReport below). After that point the report is safely
//      persisted to IndexedDB and the UI state is no longer needed, so
//      every downstream route to a new capture begins from a clean slate
//      regardless of which button the user tapped.
//
// Additions over the previous resetApp() surface:
//   - `<img>.src = ''` on every preview surface (photo-preview,
//     review-photo-thumb, summary-photo, image-viewer-img) — before this
//     they still held the prior data-URL even when state was null.
//   - `extra-photos-scroll` innerHTML cleared (was only cleared lazily when
//     stage-photo re-rendered, which didn't happen if the user took no
//     action on the next capture's photo stage).
//   - state.photoClientBlurApplied, state.mediaRecorder, state.audioChunks,
//     state.cameraStream nulled out so no stale refs leak into the next
//     capture's recorder / camera wiring.
//   - state.buildingId cleared so OSM footprint selection doesn't carry.
function _clearCaptureState() {
    inactivityManager.stop();

    // ── State fields ────────────────────────────────────────────────────────
    state.photoDataUrl = null; state.photoBlob = null; state.extraPhotos = [];
    // PR 5: blur-pending is an array now; zero it so stale promises from the
    // previous report can't make the next awaitPendingBlur() wait on them.
    state.photoBlurPending = [];
    state.photoGroupId = null; state.photoVariants = null;
    // Apr 2026 PII-blur hardening leaves a per-capture truthful flag on
    // state. Clearing it means the next capture starts from "unknown until
    // the pipeline runs", not from the previous report's answer.
    state.photoClientBlurApplied = undefined;
    state.audioBlob = null; state.transcript = ''; state.description = '';
    state.infraType = 'ROAD'; state.severity = 'MODERATE'; state.isAutoSubmit = false;
    state.crisisType = 'FLOOD'; state.damageClass = 'PARTIAL'; state.infraName = '';
    state.debrisClearing = false; state.serviceStatus = { electricity: 'UNKNOWN', water: 'UNKNOWN', health: 'UNKNOWN', pressing_needs: [] };
    // Building-footprint selection (OSM way id) — don't carry between reports.
    state.buildingId = null;
    // Media-recorder scaffolding — these accumulate across recordings and
    // must zero between reports so the next audio capture starts from a
    // clean chunk array. The recorder instance itself is closed by its
    // own stop handler; we just drop our reference.
    state.mediaRecorder = null;
    state.audioChunks = [];
    // Camera stream — if the previous capture left the live-camera modal
    // open and the user navigated back without closing it, the stream
    // could linger. Clearing the reference lets GC reclaim the track once
    // the viewfinder DOM is torn down. A proactive .getTracks().stop()
    // runs inside the camera-modal close handler; this is belt-and-braces.
    state.cameraStream = null;

    // Always reset to device GPS — never carry over user-corrected location to next report
    state.userLocationName = null; state.locationName = null;
    const cachedGps = (() => { try { return JSON.parse(localStorage.getItem('crisp_device_gps')); } catch (_) { return null; } })();
    if (cachedGps && cachedGps.lat) {
        state.location = { lat: cachedGps.lat, lng: cachedGps.lng, acc: cachedGps.acc || 0, is_user_corrected: false };
        state.deviceLocation = { lat: cachedGps.lat, lng: cachedGps.lng };
    } else {
        state.location = null;
        state.deviceLocation = null;
    }

    // ── DOM reset ───────────────────────────────────────────────────────────
    // Every lookup is guarded because elements in this list have been added/
    // removed over successive sprints. A single missing ID (#photo-skip-link
    // was the historical offender after Phase 2 made photos mandatory) used
    // to throw and abort resetApp before goToStage — which left the user
    // stranded on the success screen when they tapped "Add another report".
    // Guarded lookups make reset crash-free regardless of which DOM elements
    // the active build still has.
    const _photoPreview = document.getElementById('photo-preview');
    if (_photoPreview) {
        _photoPreview.style.display = 'none';
        // Clear .src — previously left pointing at the prior data URL even
        // after display:none, which meant any code path that unhid the
        // element (stage-photo re-entry, accessibility announcement) showed
        // the previous report's image. This is the core bleed-through fix.
        _photoPreview.src = '';
        // Drop the privacy-note overlay too — it's re-added by showPreview().
        const _privNote = _photoPreview.parentElement && _photoPreview.parentElement.querySelector('.photo-privacy-note');
        if (_privNote) _privNote.remove();
    }
    const _photoPlaceholder = document.getElementById('photo-placeholder');
    if (_photoPlaceholder) _photoPlaceholder.style.display = 'flex';
    const _btnPhotoNext = document.getElementById('btn-photo-next');
    if (_btnPhotoNext) {
        _btnPhotoNext.style.display = 'none';
        _btnPhotoNext.disabled = true;
    }
    // Apr 2026: #photo-skip-link DOM element was removed in Phase 2 when
    // photo became mandatory. Guarded lookup so reset doesn't throw if the
    // element is absent.
    const _skipLink = document.getElementById('photo-skip-link');
    if (_skipLink) _skipLink.style.display = 'block';
    // Helper text (shown until a photo is captured) — restore.
    const _helperText = document.getElementById('photo-helper');
    if (_helperText) _helperText.style.display = 'block';
    // Collapse the extras strip (multi-photo panel) — it's only visible
    // once the primary photo exists.
    const _extrasStrip = document.getElementById('extra-photos-strip');
    if (_extrasStrip) _extrasStrip.style.display = 'none';
    // Clear every thumb inside the extras strip immediately. _updateExtra
    // PhotoStrip() re-renders from state on next stage-photo entry, but if
    // the user doesn't visit stage-photo before somehow peeking at the
    // DOM (e.g. browser devtools or screenshot mode), they'd see old
    // thumbs. Belt-and-braces privacy: clear the container now.
    const _extrasScroll = document.getElementById('extra-photos-scroll');
    if (_extrasScroll) _extrasScroll.innerHTML = '';
    // Review-page thumb — populated by populateReview() on stage-review
    // entry. Not re-cleared if state.photoDataUrl is null (populateReview
    // only hides the row). Clear .src explicitly so the old bytes leave DOM.
    const _reviewThumb = document.getElementById('review-photo-thumb');
    if (_reviewThumb) _reviewThumb.src = '';
    // Summary-page photo — same story as review-photo-thumb.
    const _summaryPhoto = document.getElementById('summary-photo');
    if (_summaryPhoto) _summaryPhoto.src = '';
    // Full-screen image viewer. _closeImageViewer() clears this on close,
    // but if the user never opened/closed the viewer explicitly between
    // capture → submit → next report, the <img>.src carries over. Clear
    // it unconditionally here.
    const _viewerImg = document.getElementById('image-viewer-img');
    if (_viewerImg) _viewerImg.src = '';
    const _viewerOverlay = document.getElementById('image-viewer-overlay');
    if (_viewerOverlay) _viewerOverlay.style.display = 'none';

    const _liveTranscript = document.getElementById('live-transcript');
    if (_liveTranscript) {
        _liveTranscript.value = '';
        _liveTranscript.classList.remove('has-text', 'recording-active');
    }
    const _tlt = document.getElementById('transcript-label-text');
    if (_tlt) _tlt.textContent = 'Type what happened (optional)';
    const _hintBar = document.getElementById('transcript-hint-bar');
    if (_hintBar) _hintBar.style.display = 'none';
    const _editText = document.getElementById('edit-text');
    if (_editText) _editText.value = '';
    // Re-enable both submit buttons (old stage-send + new review page 3).
    const _bs = document.getElementById('btn-send');
    if (_bs) { _bs.disabled = false; _bs.innerHTML = `<i class="fa-solid fa-paper-plane"></i> <span>${t('send_undp')}</span>`; }
    const _brs = document.getElementById('btn-review-submit');
    if (_brs) _brs.disabled = false;
}

// Expose for the post-submit hook and tests. The pure form (no navigation)
// is the safer default; tests and submitReport can assert on the result
// without racing the stage transition.
window._clearCaptureState = _clearCaptureState;

function resetApp() {
    _clearCaptureState();
    goToStage('stage-home');
}

// Image viewer wiring — close + delete-confirm handlers attached once at boot.
// Separate from setupPhotoStage so the viewer can be opened from anywhere
// (stage-photo thumbs today, future places like review/detail).
function setupImageViewer() {
    const overlay = document.getElementById('image-viewer-overlay');
    const closeBtn = document.getElementById('btn-image-viewer-close');
    const deleteBtn = document.getElementById('btn-image-viewer-delete');
    const confirmOverlay = document.getElementById('image-delete-confirm');
    const confirmCancel = document.getElementById('btn-idc-cancel');
    const confirmOk = document.getElementById('btn-idc-confirm');
    if (!overlay) return;
    // Close button — dismisses the viewer without deleting.
    if (closeBtn) closeBtn.addEventListener('click', () => window.__crispCloseImageViewer());
    // Tap backdrop (not the image or buttons) → close.
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) window.__crispCloseImageViewer();
    });
    // Delete button inside viewer → open confirm dialog.
    if (deleteBtn) deleteBtn.addEventListener('click', () => {
        if (confirmOverlay) confirmOverlay.style.display = 'flex';
    });
    if (confirmCancel) confirmCancel.addEventListener('click', () => {
        if (confirmOverlay) confirmOverlay.style.display = 'none';
    });
    if (confirmOverlay) confirmOverlay.addEventListener('click', (e) => {
        if (e.target === confirmOverlay) confirmOverlay.style.display = 'none';
    });
    // Confirmed delete — act on the stored viewer context (primary vs extra).
    if (confirmOk) confirmOk.addEventListener('click', () => {
        const ctx = window.__crispViewerContext && window.__crispViewerContext();
        if (confirmOverlay) confirmOverlay.style.display = 'none';
        window.__crispCloseImageViewer();
        if (!ctx) return;
        if (ctx.kind === 'primary') {
            if (typeof window.__crispDeletePrimaryPhoto === 'function') window.__crispDeletePrimaryPhoto();
        } else if (ctx.kind === 'extra' && typeof ctx.index === 'number') {
            if (typeof window.removeExtraPhoto === 'function') window.removeExtraPhoto(ctx.index);
        }
    });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Setup stage modules first
    setupPhotoStage();
    setupCameraModal();
    setupImageViewer();
    setupAudioStage();
    setupReviewStage();
    setupSendStage();

    // 2. Start language detection (it will call applyI18n when ready or fallback)
    detectAndSetupLanguage();

    // 2b. Show consent gate AFTER language detection so it displays in local language
    // Language detection calls applyI18n() which updates all data-i18n elements including consent
    // Use a short delay to let async GPS/IP detection complete before showing consent
    setTimeout(_initConsentGate, 800);

    // 3. Migrate old localStorage queue to IndexedDB (backward compatibility)
    try {
        const oldQueue = JSON.parse(localStorage.getItem('crisp_queue') || '[]');
        if (oldQueue.length > 0) {
            for (const item of oldQueue) {
                const payload = item.payload || item;
                if (!payload.client_report_id) {
                    payload.client_report_id = crypto.randomUUID();
                }
                await enqueueReport(payload);
            }
            localStorage.removeItem('crisp_queue');
            console.log(`Migrated ${oldQueue.length} reports from localStorage to IndexedDB`);
        }
    } catch (e) {
        console.warn('localStorage migration failed:', e);
    }

    // 4. Start persistent retry loop for any queued reports
    startRetryLoop();

    // 5. Update sync badge
    updateSyncBadge();

    // Seed the 🟢/🔴 connectivity dot from the browser hint. The happy
    // path (navigator.onLine === true) requires NO active probing —
    // zero idle traffic. We only kick off a probe if navigator lies
    // and reports offline; the 30-s recovery loop then detects
    // reconnection and self-stops on first success.
    const _bootOnline = navigator.onLine !== false;
    _applyOnlineDot(_bootOnline);
    if (!_bootOnline) {
        // Immediate probe to correct a load-time lie (Chrome sometimes
        // reports offline for a second or two on cold start), then arm
        // the recovery loop if that probe also comes back offline.
        _probeConnectivity();
    }

    // Tap-to-re-check: users can force an immediate probe by tapping the
    // dot. Always works regardless of online/offline state — useful for a
    // user who just re-joined WiFi but the dot hasn't updated yet.
    const _dotEl = document.getElementById('connectivity-dot');
    if (_dotEl) {
        _dotEl.style.cursor = 'pointer';
        _dotEl.addEventListener('click', () => { _probeConnectivity(); });
    }

    // When the tab becomes visible again (tab-switch, laptop wake), do a
    // single probe only if we were offline. Still no polling if everything
    // is already green — just a one-shot confirmation that the dot reflects
    // current reality.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (navigator.onLine === false) _probeConnectivity();
    });

    // Connectivity event listeners.
    window.addEventListener('online', async () => {
        console.log('Back online — triggering sync');
        _applyOnlineDot(true);
        _stopConnectivityProbe();        // kill the recovery poll if it was armed
        startRetryLoop();                // resume any queued uploads
        updateSyncBadge();
    });

    window.addEventListener('offline', () => {
        console.log('Device went offline — reports will queue silently');
        _applyOnlineDot(false);
        // One immediate probe to double-check (navigator can be wrong).
        // If probe succeeds, _probeConnectivity flips green and stops.
        // If it fails, _probeConnectivity arms the 30-s recovery poll.
        _probeConnectivity();
    });

    // 7. Listen for sync success messages from service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            if (event.data.type === 'SYNC_SUCCESS') {
                showToast('Queued report synced successfully!');
                updateSyncBadge();
            }
        });
    }

    // 8. Setup start button. Phase 4 (Apr 2026): the auto-submit timer is
    // armed inside goToStage() via inactivityManager.start() when the stage
    // transitions to photo/audio/review. tryArm() is a silent no-op when
    // the user's GPS isn't inside an enabled region, so this is safe.
    document.getElementById('btn-start').addEventListener('click', () => goToStage('stage-photo'));

    // 9. Delete My Data — check if device has reports, show/hide button
    const delBtn = document.getElementById('btn-delete-my-data');
    const ddpPanel = document.getElementById('delete-data-panel');
    const ddpList = document.getElementById('ddp-list');
    const ddpClose = document.getElementById('ddp-close');
    const ddpDeleteAll = document.getElementById('ddp-delete-all');

    async function _checkDeviceReports() {
        const deviceId = localStorage.getItem('crisp_device_id');
        if (!deviceId || !delBtn) return;
        try {
            // include_deleted=true so we can show pending-deletion reports with undo option
            const res = await fetch(`${API_BASE}/reports/device/${deviceId}`);
            if (res.ok) {
                const reports = await res.json();
                delBtn.style.display = reports.length > 0 ? 'inline-flex' : 'none';
                delBtn._reports = reports;
            }
        } catch (_) { /* offline — hide button */ }
    }
    _checkDeviceReports();

    function _renderDeleteList(reports) {
        if (!ddpList) return;
        if (!reports.length) {
            ddpList.innerHTML = '<div class="ddp-empty"><i class="fa-solid fa-circle-check" style="color:#22c55e;font-size:20px;"></i><br>No data on server</div>';
            ddpDeleteAll.style.display = 'none';
            return;
        }
        // Split into active vs pending-deletion
        const active = reports.filter(r => !r.deletion_requested_at);
        const pending = reports.filter(r => r.deletion_requested_at);
        ddpDeleteAll.style.display = active.length > 0 ? 'block' : 'none';

        function _renderItem(r) {
            const loc = r.location?.user_location_name || r.location?.device_location_name || 'Unknown location';
            const time = new Date(r.server_created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            const hasImg = r.media?.some(m => m.type === 'IMAGE' && m.assembly_status === 'complete');
            const hasAudio = r.media?.some(m => m.type === 'AUDIO' && m.assembly_status === 'complete');
            const isPending = !!r.deletion_requested_at;

            let countdown = '';
            if (isPending) {
                const delAt = new Date(r.deletion_requested_at);
                const expiresAt = new Date(delAt.getTime() + 24 * 60 * 60 * 1000);
                const remaining = Math.max(0, expiresAt - Date.now());
                const hrs = Math.floor(remaining / 3600000);
                const mins = Math.floor((remaining % 3600000) / 60000);
                countdown = `${hrs}h ${mins}m remaining`;
            }

            return `<div class="ddp-item ${isPending ? 'ddp-item-pending' : ''}" data-id="${r.id}">
                <div class="ddp-item-info">
                    <div class="ddp-item-type"><i class="fa-solid fa-triangle-exclamation" style="color:${r.severity === 'SEVERE' ? '#ef4444' : r.severity === 'MODERATE' ? '#f59e0b' : '#22c55e'};"></i> ${r.infrastructure_type} — ${r.severity}</div>
                    <div class="ddp-item-meta">${loc} · ${time}</div>
                    ${isPending ? `<div class="ddp-pending-label"><i class="fa-solid fa-clock"></i> Deletion scheduled — ${countdown}</div>` : `
                    <div class="ddp-item-media">
                        ${hasImg ? '<span><i class="fa-solid fa-image"></i> Photo</span>' : ''}
                        ${hasAudio ? '<span><i class="fa-solid fa-microphone"></i> Audio</span>' : ''}
                    </div>`}
                </div>
                ${isPending
                    ? `<button class="ddp-item-undo" onclick="undoDeleteReport('${r.id}', this)"><i class="fa-solid fa-rotate-left"></i> Undo</button>`
                    : `<button class="ddp-item-del" onclick="deleteOneReport('${r.id}', this)"><i class="fa-solid fa-trash"></i></button>`
                }
            </div>`;
        }

        let html = active.map(_renderItem).join('');
        if (pending.length > 0) {
            html += `<div class="ddp-pending-section"><div class="ddp-pending-header"><i class="fa-solid fa-hourglass-half"></i> Pending Deletion</div>${pending.map(_renderItem).join('')}</div>`;
        }
        ddpList.innerHTML = html;
    }

    window.deleteOneReport = async (reportId, btn) => {
        if (!confirm(t('delete_confirm') || 'Delete this report? Your data will be permanently deleted within 24 hours. You can undo this within that time.')) return;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            const res = await fetch(`${API_BASE}/reports/${reportId}`, { method: 'DELETE' });
            if (res.ok) {
                const result = await res.json();
                alert(result.message || 'Your data will be permanently deleted within 24 hours.');
                // Refresh list to show undo option
                setTimeout(async () => {
                    await _checkDeviceReports();
                    _renderDeleteList(delBtn._reports || []);
                }, 400);
            }
        } catch (_) { alert('Could not reach server.'); }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    };

    window.undoDeleteReport = async (reportId, btn) => {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            const res = await fetch(`${API_BASE}/reports/${reportId}/undo-delete`, { method: 'POST' });
            if (res.ok) {
                setTimeout(async () => {
                    await _checkDeviceReports();
                    _renderDeleteList(delBtn._reports || []);
                }, 300);
            } else {
                const err = await res.json().catch(() => ({}));
                alert(err.detail || 'Could not undo deletion.');
            }
        } catch (_) { alert('Could not reach server.'); }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Undo';
    };

    const langSwitcherEl = document.getElementById('lang-switcher');
    const ddpLangSwitch = document.getElementById('ddp-lang-switch');

    // Build a mini lang switcher for the delete panel
    function _buildDdpLangSwitch() {
        if (!ddpLangSwitch) return;
        const localBtn = document.getElementById('btn-lang-local');
        const localLang = localBtn?.dataset?.lang;
        const localLabel = localBtn?.textContent?.trim();
        if (localLang && localLang !== 'en' && localLabel) {
            ddpLangSwitch.innerHTML = `
                <button class="ddp-lang-btn ${state.lang !== 'en' ? 'active' : ''}" data-dlang="${localLang}">${localLabel}</button>
                <button class="ddp-lang-btn ${state.lang === 'en' ? 'active' : ''}" data-dlang="en">EN</button>`;
        } else {
            ddpLangSwitch.innerHTML = '';
            return;
        }
        ddpLangSwitch.querySelectorAll('.ddp-lang-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.dlang;
                // Reuse the main activateLang via the main lang buttons
                const mainBtn = code === 'en' ? document.getElementById('btn-lang-en') : document.getElementById('btn-lang-local');
                if (mainBtn) mainBtn.click();
                ddpLangSwitch.querySelectorAll('.ddp-lang-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // Re-render the delete list in new language
                if (delBtn._reports) _renderDeleteList(delBtn._reports);
            });
        });
    }

    if (delBtn) {
        delBtn.addEventListener('click', () => {
            ddpPanel.style.display = 'block';
            if (langSwitcherEl) langSwitcherEl.style.display = 'none';
            _buildDdpLangSwitch();
            _renderDeleteList(delBtn._reports || []);
        });
    }
    if (ddpClose) {
        ddpClose.addEventListener('click', () => {
            ddpPanel.style.display = 'none';
            if (langSwitcherEl) langSwitcherEl.style.display = '';
        });
    }
    if (ddpDeleteAll) {
        ddpDeleteAll.addEventListener('click', async () => {
            if (!confirm('This will permanently delete ALL your submitted reports and media from the server. This cannot be undone.\n\nContinue?')) return;
            const deviceId = localStorage.getItem('crisp_device_id');
            if (!deviceId) return;
            ddpDeleteAll.disabled = true;
            ddpDeleteAll.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting all...';
            try {
                const res = await fetch(`${API_BASE}/reports/device/${deviceId}`, { method: 'DELETE' });
                if (res.ok) {
                    const result = await res.json();
                    localStorage.removeItem('crisp_device_id');
                    localStorage.removeItem('crisp_privacy_consent');
                    try { const db = await openIDB(); const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).clear(); } catch(_){}
                    alert(`${result.deleted} report(s) deleted.\nAll local data cleared.`);
                    location.reload();
                }
            } catch (_) { alert('Could not reach server.'); }
            ddpDeleteAll.disabled = false;
            ddpDeleteAll.innerHTML = '<i class="fa-solid fa-trash-can"></i> Delete All Reports';
        });
    }

    // 9. Show home
    goToStage('stage-home');
});
