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
    document.getElementById('upload-status-text').textContent = statusText || 'Sending report...';
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
    document.getElementById('upload-status-text').textContent = 'Report sent!';
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
            text.textContent = `Syncing ${syncing}/${items.length}...`;
        } else if (failed > 0) {
            badge.className = 'sync-badge error';
            text.textContent = `${items.length} queued (${failed} failed)`;
        } else {
            badge.className = 'sync-badge';
            text.textContent = `${items.length} queued`;
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
                } catch (_) {}
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
                } catch (_) {}
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
                    } catch (_) {}
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
                } catch (_) {}
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
        home_title: "Report", home_sub: "Quick & Easy\n4 steps.",
        rs1: "PHOTO", rs2: "VOICE", rs3: "CHECK", rs4: "SEND",
        start_btn: "START",
        s1_title: "PHOTO", s1_sub: "Take picture",
        no_photo: "No photo", use_camera: "Camera", browse: "Files", skip_photo: "Skip", next: "NEXT",
        pii_warning: "Avoid faces or personal documents. Faces will be auto-blurred for privacy.",
        s2_title: "VOICE", s2_sub: "Speak now",
        tap_mic: "TAP to SPEAK", transcript_hint: "Listening...",
        skip_audio: "I will type",
        s3_title: "CHECK", s3_sub: "Fix text",
        photo_attached: "✅ Added", your_message: "Message:", type_your_msg: "Type...",
        what_damaged: "Damage?", road: "Road", hospital: "Clinic", house: "Home", power: "Power", water: "Water", other: "Other",
        severity_label: "Severity?", minor: "Low", moderate: "Mid", severe: "High", ready_send: "READY",
        s4_title: "SEND", s4_sub: "Tap below",
        report_id: "ID:", send_undp: "SEND", go_back: "Edit",
        sent_title: "SENT!", sent_sub: "Help is coming.\nThank you.",
        new_report: "NEW",
        search_place: "Type place name...", loc_status: "Locating...",
        loc_verified: "Verified", loc_missing: "No GPS",
        loc_error: "GPS Error", loc_not_supported: "No GPS",
        retry_gps: "Tap 🔄 to retry"
    },
    kn: {
        consent_title: "ನಿಮ್ಮ ಗೌಪ್ಯತೆ ಮುಖ್ಯ", consent_desc: "ರಕ್ಷಣಾ ತಂಡಗಳಿಗೆ ಸಹಾಯ ಮಾಡಲು ಅಗತ್ಯ ಮಾಹಿತಿ ಮಾತ್ರ:", consent_loc: "ಸ್ಥಳ — GPS ನಿರ್ದೇಶಾಂಕಗಳು", consent_photo: "ಫೋಟೋಗಳು — ಹಾನಿ ಸಾಕ್ಷ್ಯ", consent_audio: "ಆಡಿಯೋ — ಧ್ವನಿ ವಿವರಣೆ", consent_no_pii: "ವೈಯಕ್ತಿಕ ಗುರುತು ಸಂಗ್ರಹಿಸಲಾಗುವುದಿಲ್ಲ", consent_shared: "ಬಿಕ್ಕಟ್ಟು ಪ್ರತಿಕ್ರಿಯಾಕಾರರಿಗೆ ಮಾತ್ರ", consent_delete: "ಯಾವಾಗ ಬೇಕಾದರೂ ಅಳಿಸಬಹುದು", consent_check: "ಈ ಡೇಟಾ ಹಂಚಿಕೊಳ್ಳಲು ಒಪ್ಪುತ್ತೇನೆ", consent_accept: "ಒಪ್ಪಿ ಮುಂದುವರಿಸಿ",
        delete_my_data: "ನನ್ನ ಡೇಟಾ ಅಳಿಸಿ", your_reports: "ನಿಮ್ಮ ವರದಿಗಳು", delete_all: "ಎಲ್ಲಾ ಅಳಿಸಿ",
        home_title: "ವರದಿ", home_sub: "ಸರಳ ಮತ್ತು ವೇಗ.\n4 ಹೆಜ್ಜೆಗಳು.",
        rs1: "ಫೋಟೋ", rs2: "ಧ್ವನಿ", rs3: "ಪರಿಶೀಲಿಸಿ", rs4: "ಕಳುಹಿಸಿ",
        start_btn: "ಪ್ರಾರಂಭಿಸಿ",
        s1_title: "ಫೋಟೋ", s1_sub: "ಚಿತ್ರ ತೆಗೆಯಿರಿ",
        no_photo: "ಹಾಕಿ", use_camera: "ಕ್ಯಾಮೆರಾ", browse: "ಹುಡುಕಿ", skip_photo: "ಬಿಟ್ಟುಬಿಡಿ", next: "ಮುಂದೆ",
        s2_title: "ಧ್ವನಿ", s2_sub: "ಮಾತನಾಡಿ",
        tap_mic: "ಮಾತನಾಡಲು ಒತ್ತಿ", transcript_hint: "ಕೇಳುತ್ತಿದ್ದೇವೆ...",
        skip_audio: "ಟೈಪ್ ಮಾಡಿ",
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
        retry_gps: "Tap 🔄 ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಲು"
    },
    hi: {
        consent_title: "आपकी गोपनीयता महत्वपूर्ण है", consent_desc: "बचाव दलों की मदद के लिए केवल आवश्यक डेटा:", consent_loc: "स्थान — GPS निर्देशांक", consent_photo: "फोटो — क्षति का प्रमाण", consent_audio: "ऑडियो — आवाज विवरण", consent_no_pii: "कोई व्यक्तिगत पहचान नहीं", consent_shared: "केवल आपदा प्रतिक्रियाकर्ताओं के लिए", consent_delete: "कभी भी हटा सकते हैं", consent_check: "मैं इस डेटा को साझा करने के लिए सहमत हूँ", consent_accept: "स्वीकार करें",
        delete_my_data: "मेरा डेटा हटाएं", your_reports: "आपकी रिपोर्टें", delete_all: "सभी हटाएं",
        home_title: "रिपोर्ट", home_sub: "सरल और तेज़।\n4 कदम।",
        rs1: "फोटो", rs2: "आवाज़", rs3: "जांचें", rs4: "भेजें",
        start_btn: "शुरू करें",
        s1_title: "फोटो", s1_sub: "चित्र लें",
        no_photo: "नहीं है", use_camera: "कैमरा", browse: "फाइल", skip_photo: "छोड़ें", next: "आगे",
        pii_warning: "चेहरे या व्यक्तिगत दस्तावेज न दिखाएं। चेहरे गोपनीयता के लिए स्वचालित रूप से धुंधले होंगे।",
        s2_title: "आवाज़", s2_sub: "बोलें",
        tap_mic: "बोलने के लिए दबाएं", transcript_hint: "सुन रहे हैं...",
        skip_audio: "टाइप करें",
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
        retry_gps: "Tap 🔄 फिर से"
    },
    ta: {
        consent_title: "உங்கள் தனியுரிமை முக்கியம்", consent_desc: "மீட்புக் குழுக்களுக்கு உதவ தேவையான தகவல் மட்டும்:", consent_loc: "இடம் — GPS ஆயங்கள்", consent_photo: "புகைப்படங்கள் — சேத ஆதாரம்", consent_audio: "ஆடியோ — குரல் விளக்கம்", consent_no_pii: "தனிப்பட்ட அடையாளம் சேகரிக்கப்படாது", consent_shared: "நெருக்கடி மீட்பாளர்களுக்கு மட்டும்", consent_delete: "எப்போது வேண்டுமானாலும் நீக்கலாம்", consent_check: "இந்தத் தகவலைப் பகிர ஒப்புக்கொள்கிறேன்", consent_accept: "ஏற்கவும்",
        delete_my_data: "என் தரவை நீக்கு", your_reports: "உங்கள் அறிக்கைகள்", delete_all: "அனைத்தும் நீக்கு",
        skip_audio: "தவிர்க்கவும் — நான் தட்டச்சு செய்வேன்",
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
        retry_gps: "மீண்டும் முயற்சிக்க புதுப்பிக்கவும்"
    }
};

const state = {
    lang: 'en',
    photoDataUrl: null,
    photoBlob: null,
    extraPhotos: [],  // Array of { dataUrl, blob } for additional photos
    audioBlob: null,
    transcript: '',
    description: '',
    infraType: 'ROAD',
    severity: 'MODERATE',
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

// ── Inactivity Manager (Auto-Submit) ───────────────────────────────────────────
class InactivityManager {
    constructor(timeoutMs = 120000, onTimeout = null) {
        this.timeoutMs = timeoutMs;
        this.onTimeout = onTimeout;
        this.timeRemaining = timeoutMs;
        this.timerInterval = null;
        this.isActive = false;
        this.activities = ['input', 'change', 'click', 'touchstart', 'touchend', 'keydown'];
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.timeRemaining = this.timeoutMs;
        this.updateDisplay();

        // Start countdown timer
        this.timerInterval = setInterval(() => {
            this.timeRemaining -= 100;
            this.updateDisplay();
            if (this.timeRemaining <= 0) {
                this.stop();
                if (this.onTimeout) this.onTimeout();
            }
        }, 100);

        // Add activity listeners
        this.activities.forEach(event => {
            document.addEventListener(event, () => this.reset(), true);
        });
        document.addEventListener('mousemove', () => this.reset());
    }

    reset() {
        if (!this.isActive) return;
        this.timeRemaining = this.timeoutMs;
        this.updateDisplay();
    }

    updateDisplay() {
        const timerEl = document.getElementById('auto-submit-timer');
        const displayEl = document.getElementById('timer-display');
        if (!timerEl || !displayEl) return;

        const seconds = Math.ceil(this.timeRemaining / 1000);
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        displayEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    stop() {
        this.isActive = false;
        if (this.timerInterval) clearInterval(this.timerInterval);
        const timerEl = document.getElementById('auto-submit-timer');
        if (timerEl) timerEl.style.display = 'none';
        this.activities.forEach(event => {
            document.removeEventListener(event, () => this.reset(), true);
        });
        document.removeEventListener('mousemove', () => this.reset());
    }

    show() {
        const timerEl = document.getElementById('auto-submit-timer');
        if (timerEl) timerEl.style.display = 'flex';
    }

    hide() {
        const timerEl = document.getElementById('auto-submit-timer');
        if (timerEl) timerEl.style.display = 'none';
    }
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

// ── i18n helpers ───────────────────────────────────────────────────────────────
function t(key) { return (I18N[state.lang] || I18N.en)[key] || key; }

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
}

// ── Stage navigation ───────────────────────────────────────────────────────────
const STAGES = ['stage-home', 'stage-photo', 'stage-audio', 'stage-review', 'stage-send', 'stage-success'];

function goToStage(id) {
    STAGES.forEach(s => document.getElementById(s).classList.remove('active'));
    document.getElementById(id).classList.add('active');

    const idx = STAGES.indexOf(id);
    const pct = idx === 0 ? 0 : Math.round((idx / (STAGES.length - 2)) * 100);
    document.getElementById('progress-bar-fill').style.width = pct + '%';
    document.getElementById('progress-bar-container').style.display = (id === 'stage-home' || id === 'stage-success') ? 'none' : 'block';

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
    ml: { home_title: 'ഒരു സംഭവം റിപ്പോർട്ട് ചെയ്യൂ', start_btn: 'റിപ്പോർട്ട് ആരംഭിക്കുക', use_camera: 'ക്യാമറ', browse: 'ബ്രൗസ്', skip_photo: 'ഒഴിവാക്കുക', next: 'അടുത്തത്', tap_mic: 'സംസാരിക്കാൻ ടാപ്പ് ചെയ്യുക', send_undp: 'UNDP-ലേക്ക് അയയ്ക്കുക', sent_title: 'റിപ്പോർട്ട് അയച്ചു!' },
    te: { home_title: 'సంఘటన నివేదించండి', start_btn: 'నివేదిక ప్రారంభించండి', use_camera: 'కెమెరా', browse: 'బ్రౌజ్', skip_photo: 'దాటవేయి', next: 'తదుపరి', tap_mic: 'మాట్లాడటానికి నొక్కండి', send_undp: 'UNDP కు పంపండి', sent_title: 'నివేదిక పంపబడింది!' },
    mr: { home_title: 'घटना नोंदवा', start_btn: 'अहवाल सुरू करा', use_camera: 'कॅमेरा', browse: 'ब्राउज', skip_photo: 'वगळा', next: 'पुढे', tap_mic: 'बोलण्यासाठी दाबा', send_undp: 'UNDP ला पाठवा', sent_title: 'अहवाल पाठवला!' },
    gu: { home_title: 'ઘટનાની જાણ કરો', start_btn: 'રિપોર્ટ શરૂ કરો', use_camera: 'કૅમેરા', browse: 'શોધો', skip_photo: 'છોડો', next: 'આગળ', tap_mic: 'બોલવા દબાવો', send_undp: 'UNDP ને મોકલો', sent_title: 'રિપોર્ट મોकвायो!' },
    sw: { home_title: 'Ripoti', start_btn: 'Anza', use_camera: 'Kamera', browse: 'Tafuta', skip_photo: 'Ruka', next: 'Endelea', tap_mic: 'Rekodi', send_undp: 'Tuma', sent_title: 'Imetumwa!', consent_title: 'Faragha yako ni muhimu', consent_check: 'Nakubali kushiriki data', consent_accept: 'Kubali' },
    // ── UN official + major global languages ──
    fr: { home_title: 'Signaler', start_btn: 'Commencer', use_camera: 'Photo', browse: 'Parcourir', skip_photo: 'Passer', next: 'Suivant', tap_mic: 'Parler', send_undp: 'Envoyer', sent_title: 'Envoyé!', consent_title: 'Votre vie privée compte', consent_desc: 'CRISP collecte uniquement les données nécessaires:', consent_loc: 'Localisation — coordonnées GPS', consent_photo: 'Photos — preuves de dégâts', consent_audio: 'Audio — descriptions vocales', consent_no_pii: 'Aucune identité personnelle collectée', consent_shared: 'Données partagées uniquement avec les secours', consent_delete: 'Suppression possible à tout moment', consent_check: 'Je consens au partage de ces données', consent_accept: 'Accepter', delete_my_data: 'Supprimer mes données', your_reports: 'Vos rapports soumis', delete_all: 'Tout supprimer' },
    es: { home_title: 'Reportar', start_btn: 'Iniciar', use_camera: 'Cámara', browse: 'Buscar', skip_photo: 'Omitir', next: 'Siguiente', tap_mic: 'Hablar', send_undp: 'Enviar', sent_title: 'Enviado!', consent_title: 'Su privacidad importa', consent_desc: 'CRISP recopila solo los datos necesarios:', consent_loc: 'Ubicación — coordenadas GPS', consent_photo: 'Fotos — evidencia de daños', consent_audio: 'Audio — descripción por voz', consent_no_pii: 'No se recopila identidad personal', consent_shared: 'Datos solo para equipos de rescate', consent_delete: 'Puede solicitar eliminación', consent_check: 'Consiento compartir estos datos', consent_accept: 'Aceptar', delete_my_data: 'Eliminar mis datos', your_reports: 'Sus informes', delete_all: 'Eliminar todo' },
    ar: { home_title: 'إبلاغ', start_btn: 'ابدأ', use_camera: 'كاميرا', browse: 'تصفح', skip_photo: 'تخطي', next: 'التالي', tap_mic: 'تحدث', send_undp: 'إرسال', sent_title: 'تم!', consent_title: 'خصوصيتك مهمة', consent_desc: 'يجمع CRISP فقط البيانات اللازمة:', consent_loc: 'الموقع — إحداثيات GPS', consent_photo: 'صور — أدلة الأضرار', consent_audio: 'صوت — وصف صوتي', consent_no_pii: 'لا يتم جمع هوية شخصية', consent_shared: 'البيانات للمستجيبين فقط', consent_delete: 'يمكنك طلب الحذف', consent_check: 'أوافق على مشاركة هذه البيانات', consent_accept: 'قبول', delete_my_data: 'حذف بياناتي', your_reports: 'تقاريرك', delete_all: 'حذف الكل' },
    ru: { home_title: 'Сообщить', start_btn: 'Начать', use_camera: 'Камера', browse: 'Обзор', skip_photo: 'Пропустить', next: 'Далее', tap_mic: 'Говорить', send_undp: 'Отправить', sent_title: 'Отправлено!', consent_title: 'Ваша конфиденциальность важна', consent_check: 'Я согласен на передачу данных', consent_accept: 'Принять' },
    zh: { home_title: '报告', start_btn: '开始', use_camera: '相机', browse: '浏览', skip_photo: '跳过', next: '下一步', tap_mic: '说话', send_undp: '发送', sent_title: '已发送!', consent_title: '您的隐私很重要', consent_check: '我同意分享此数据', consent_accept: '接受' },
    pt: { home_title: 'Reportar', start_btn: 'Iniciar', use_camera: 'Câmera', browse: 'Procurar', skip_photo: 'Pular', next: 'Próximo', tap_mic: 'Falar', send_undp: 'Enviar', sent_title: 'Enviado!', consent_title: 'Sua privacidade importa', consent_check: 'Concordo em compartilhar dados', consent_accept: 'Aceitar' },
    de: { home_title: 'Melden', start_btn: 'Starten', use_camera: 'Kamera', browse: 'Suchen', skip_photo: 'Überspringen', next: 'Weiter', tap_mic: 'Sprechen', send_undp: 'Senden', sent_title: 'Gesendet!', consent_title: 'Ihre Privatsphäre ist wichtig', consent_check: 'Ich stimme der Datenweitergabe zu', consent_accept: 'Akzeptieren' },
    it: { home_title: 'Segnala', start_btn: 'Inizia', use_camera: 'Foto', browse: 'Sfoglia', skip_photo: 'Salta', next: 'Avanti', tap_mic: 'Parla', send_undp: 'Invia', sent_title: 'Inviato!', consent_title: 'La tua privacy è importante', consent_check: 'Acconsento alla condivisione dei dati', consent_accept: 'Accetta' },
    tr: { home_title: 'Bildir', start_btn: 'Başla', use_camera: 'Kamera', browse: 'Ara', skip_photo: 'Atla', next: 'İleri', tap_mic: 'Konuş', send_undp: 'Gönder', sent_title: 'Gönderildi!', consent_title: 'Gizliliğiniz önemli', consent_check: 'Veri paylaşmayı kabul ediyorum', consent_accept: 'Kabul et' },
    uk: { home_title: 'Повідомити', start_btn: 'Почати', use_camera: 'Камера', browse: 'Огляд', skip_photo: 'Пропустити', next: 'Далі', tap_mic: 'Записати', send_undp: 'Надіслати', sent_title: 'Надіслано!', consent_title: 'Ваша конфіденційність важлива', consent_check: 'Я погоджуюсь на передачу даних', consent_accept: 'Прийняти' },
    ja: { home_title: '報告', start_btn: '開始', use_camera: 'カメラ', browse: '参照', skip_photo: 'スキップ', next: '次へ', tap_mic: '話す', send_undp: '送信', sent_title: '送信済み!', consent_title: 'プライバシーについて', consent_check: 'データ共有に同意します', consent_accept: '同意' },
    ko: { home_title: '신고', start_btn: '시작', use_camera: '카메라', browse: '찾기', skip_photo: '건너뛰기', next: '다음', tap_mic: '말하기', send_undp: '보내기', sent_title: '전송됨!', consent_title: '개인정보 보호', consent_check: '데이터 공유에 동의합니다', consent_accept: '동의' },
    am: { home_title: 'ሪፖርት', start_btn: 'ጀምር', use_camera: 'ካሜራ', browse: 'ፈልግ', skip_photo: 'ዝለል', next: 'ቀጣይ', tap_mic: 'ንካ', send_undp: 'ላክ', sent_title: 'ተልኳል!', consent_title: 'ግላዊነትዎ ጠቃሚ', consent_check: 'ዳታ ማጋራት እስማማለሁ', consent_accept: 'ተቀበል' },
    ur: { home_title: 'رپورٹ', start_btn: 'شروع', use_camera: 'کیمرا', browse: 'تلاش', skip_photo: 'چھوڑیں', next: 'اگلا', tap_mic: 'بولیں', send_undp: 'بھیجیں', sent_title: 'بھیج دیا!', consent_title: 'آپ کی رازداری اہم ہے', consent_check: 'ڈیٹا شیئر کرنے پر متفق', consent_accept: 'قبول' },
    ne: { home_title: 'रिपोर्ट', start_btn: 'सुरु', use_camera: 'क्यामेरा', browse: 'खोज', skip_photo: 'छोड्नुहोस्', next: 'अर्को', tap_mic: 'बोल्नुहोस्', send_undp: 'पठाउ', sent_title: 'पठाइयो!', consent_title: 'तपाईंको गोपनीयता महत्त्वपूर्ण', consent_check: 'डाटा साझा गर्न सहमत', consent_accept: 'स्वीकार' },
    th: { home_title: 'รายงาน', start_btn: 'เริ่ม', use_camera: 'กล้อง', browse: 'ค้นหา', skip_photo: 'ข้าม', next: 'ถัดไป', tap_mic: 'พูด', send_undp: 'ส่ง', sent_title: 'ส่งแล้ว!', consent_title: 'ความเป็นส่วนตัวสำคัญ', consent_check: 'ยินยอมแบ่งปันข้อมูล', consent_accept: 'ยอมรับ' },
    vi: { home_title: 'Báo cáo', start_btn: 'Bắt đầu', use_camera: 'Máy ảnh', browse: 'Duyệt', skip_photo: 'Bỏ qua', next: 'Tiếp', tap_mic: 'Nói', send_undp: 'Gửi', sent_title: 'Đã gửi!', consent_title: 'Quyền riêng tư quan trọng', consent_check: 'Tôi đồng ý chia sẻ dữ liệu', consent_accept: 'Chấp nhận' },
    id: { home_title: 'Laporan', start_btn: 'Mulai', use_camera: 'Kamera', browse: 'Cari', skip_photo: 'Lewati', next: 'Lanjut', tap_mic: 'Bicara', send_undp: 'Kirim', sent_title: 'Terkirim!', consent_title: 'Privasi Anda penting', consent_check: 'Saya setuju membagikan data', consent_accept: 'Terima' },
    ms: { home_title: 'Laporan', start_btn: 'Mula', use_camera: 'Kamera', browse: 'Cari', skip_photo: 'Langkau', next: 'Seterusnya', tap_mic: 'Bercakap', send_undp: 'Hantar', sent_title: 'Dihantar!', consent_title: 'Privasi anda penting', consent_check: 'Saya bersetuju berkongsi data', consent_accept: 'Terima' },
    km: { home_title: 'រាយការណ៍', start_btn: 'ចាប់ផ្តើម', use_camera: 'កាមេរ៉ា', browse: 'រុករក', skip_photo: 'រំលង', next: 'បន្ទាប់', tap_mic: 'និយាយ', send_undp: 'ផ្ញើ', sent_title: 'បានផ្ញើ!', consent_title: 'ភាពឯកជនសំខាន់', consent_check: 'ខ្ញុំយល់ព្រមចែករំលែកទិន្នន័យ', consent_accept: 'ទទួលយក' },
    fa: { home_title: 'گزارش', start_btn: 'شروع', use_camera: 'دوربین', browse: 'مرور', skip_photo: 'رد شو', next: 'بعدی', tap_mic: 'صحبت', send_undp: 'ارسال', sent_title: 'ارسال شد!', consent_title: 'حریم خصوصی شما مهم است', consent_check: 'موافقم داده‌ها را به اشتراک بگذارم', consent_accept: 'قبول' },
    my: { home_title: 'အစီရင်ခံ', start_btn: 'စတင်', use_camera: 'ကင်မရာ', browse: 'ရှာ', skip_photo: 'ကျော်', next: 'ရှေ့', tap_mic: 'ပြော', send_undp: 'ပို့', sent_title: 'ပို့ပြီး!', consent_title: 'ကိုယ်ရေးအချက်အလက် အရေးကြီးသည်', consent_check: 'ဒေတာမျှဝေရန် သဘောတူသည်', consent_accept: 'လက်ခံ' },
    pl: { home_title: 'Zgłoś', start_btn: 'Rozpocznij', use_camera: 'Aparat', browse: 'Szukaj', skip_photo: 'Pomiń', next: 'Dalej', tap_mic: 'Mów', send_undp: 'Wyślij', sent_title: 'Wysłano!', consent_title: 'Twoja prywatność jest ważna', consent_check: 'Wyrażam zgodę na udostępnienie danych', consent_accept: 'Akceptuj' },
    ro: { home_title: 'Raportează', start_btn: 'Începe', use_camera: 'Cameră', browse: 'Caută', skip_photo: 'Omite', next: 'Următor', tap_mic: 'Vorbește', send_undp: 'Trimite', sent_title: 'Trimis!', consent_title: 'Confidențialitatea contează', consent_check: 'Sunt de acord să partajez date', consent_accept: 'Accept' },
    so: { home_title: 'Warbixin', start_btn: 'Bilow', use_camera: 'Kamarad', browse: 'Raadi', skip_photo: 'Ka bood', next: 'Xiga', tap_mic: 'Hadal', send_undp: 'Dir', sent_title: 'La diray!', consent_title: 'Asturnaantaadu muhiim', consent_check: 'Waan ogolahay in xogta la wadaago', consent_accept: 'Aqbal' },
    si: { home_title: 'වාර්තාව', start_btn: 'ආරම්භ', use_camera: 'කැමරාව', browse: 'සොයන්න', skip_photo: 'මඟ හරින්න', next: 'ඊළඟ', tap_mic: 'කතා කරන්න', send_undp: 'යවන්න', sent_title: 'යැවීය!', consent_title: 'ඔබේ පෞද්ගලිකත්වය වැදගත්', consent_check: 'දත්ත බෙදා ගැනීමට එකඟ', consent_accept: 'පිළිගන්න' },
    he: { home_title: 'דווח', start_btn: 'התחל', use_camera: 'מצלמה', browse: 'חפש', skip_photo: 'דלג', next: 'הבא', tap_mic: 'דבר', send_undp: 'שלח', sent_title: 'נשלח!', consent_title: 'הפרטיות שלך חשובה', consent_check: 'אני מסכים לשתף נתונים', consent_accept: 'אישור' },
    el: { home_title: 'Αναφορά', start_btn: 'Έναρξη', use_camera: 'Κάμερα', browse: 'Αναζήτηση', skip_photo: 'Παράλειψη', next: 'Επόμενο', tap_mic: 'Μιλήστε', send_undp: 'Αποστολή', sent_title: 'Εστάλη!', consent_title: 'Το απόρρητό σας μετράει', consent_check: 'Συμφωνώ να μοιραστώ δεδομένα', consent_accept: 'Αποδοχή' },
    bn: { home_title: 'রিপোর্ট', start_btn: 'শুরু', use_camera: 'ক্যামেরা', browse: 'খুঁজুন', skip_photo: 'বাদ', next: 'পরবর্তী', tap_mic: 'চাপুন', send_undp: 'পাঠান', sent_title: 'পাঠানো হয়েছে!', consent_title: 'আপনার গোপনীয়তা গুরুত্বপূর্ণ', consent_check: 'ডেটা শেয়ার করতে সম্মত', consent_accept: 'গ্রহণ' },
    pa: { home_title: 'ਰਿਪੋਰਟ', start_btn: 'ਸ਼ੁਰੂ', use_camera: 'ਕੈਮਰਾ', browse: 'ਖੋਜੋ', skip_photo: 'ਛੱਡੋ', next: 'ਅੱਗੇ', tap_mic: 'ਦਬਾਓ', send_undp: 'ਭੇਜੋ', sent_title: 'ਭੇਜਿਆ!', consent_title: 'ਤੁਹਾਡੀ ਗੋਪਨੀਯਤਾ ਮਹੱਤਵਪੂਰਨ', consent_check: 'ਡੇਟਾ ਸਾਂਝਾ ਕਰਨ ਲਈ ਸਹਿਮਤ', consent_accept: 'ਸਵੀਕਾਰ' },
};

function detectAndSetupLanguage() {
    const langSwitcher = document.getElementById('lang-switcher');
    const localBtn = document.getElementById('btn-lang-local');
    const enBtn = document.getElementById('btn-lang-en');

    function activateLang(code) {
        state.lang = code;
        // Merge extra strings if available
        if (EXTRA_LANG[code]) {
            I18N[code] = Object.assign({}, I18N.en, EXTRA_LANG[code]);
        }
        applyI18n();
        // Resolve speech code and store on state so setupAudioStage can use it
        const entry = REGION_LANG_MAP.find(r => r.code === code);
        const countryEntry = Object.values(COUNTRY_LANG_DATA).find(e => e.code === code);
        state.speechCode = entry ? entry.speech : (countryEntry ? countryEntry.speech : 'en-IN');
        // Update live recognition instance if already created
        if (state.recognition) {
            state.recognition.lang = state.speechCode;
        }
    }

    function showLocalLangBtn(code, label) {
        localBtn.dataset.lang = code;
        localBtn.textContent = label;
        localBtn.style.display = 'inline-block';
        
        // If we found a local lang, make it active by default
        localBtn.classList.add('active');
        enBtn.classList.remove('active');
        activateLang(code);
    }

    // Wire up button clicks
    localBtn.addEventListener('click', () => {
        localBtn.classList.add('active');
        enBtn.classList.remove('active');
        activateLang(localBtn.dataset.lang);
    });
    enBtn.addEventListener('click', () => {
        enBtn.classList.add('active');
        localBtn.classList.remove('active');
        activateLang('en');
    });

    // ── Restore cached location + language instantly (before any network call) ──
    // (_LOC_CTX_KEY, _saveLocCtx, _patchLocCtx are module-scope — defined near resolveLocationName)

    function _applyLocCtx(ctx) {
        // Restore location state
        state.location     = { lat: ctx.lat, lng: ctx.lng, acc: ctx.acc };
        state.deviceLocation = { lat: ctx.lat, lng: ctx.lng };
        state.locationName = ctx.name || null;
        // Restore language
        if (ctx.lang && ctx.lang !== 'en' && ctx.langLabel) {
            showLocalLangBtn(ctx.lang, ctx.langLabel, ctx.speechCode || 'en-IN');
        } else {
            activateLang(ctx.lang || 'en');
        }
        // Update location display immediately — no "Locating..." shown
        const locCoords = document.getElementById('loc-coords');
        if (locCoords && ctx.name) locCoords.textContent = ctx.name;
        const summaryLoc = document.getElementById('summary-loc');
        if (summaryLoc && ctx.name) summaryLoc.textContent = ctx.name;
    }

    const _cachedCtx = (() => {
        try { return JSON.parse(localStorage.getItem(_LOC_CTX_KEY) || 'null'); } catch (_) { return null; }
    })();

    if (_cachedCtx && _cachedCtx.lat) {
        // Apply instantly — user sees their previous location, no "Locating..."
        _applyLocCtx(_cachedCtx);
    } else {
        // First ever launch — show "Locating..." only when no cache exists
        const homeTitle = document.querySelector('[data-i18n="home_title"]');
        if (homeTitle) homeTitle.textContent = "Locating...";
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
        if (typeof placeSearch !== 'undefined') {
            placeSearch.prefetchNearby(pos.coords.latitude, pos.coords.longitude);
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
    const skipLink = document.getElementById('photo-skip-link');

    function showPreview(dataUrl) {
        previewImg.src = dataUrl;
        previewImg.style.display = 'block';
        placeholder.style.display = 'none';
        nextBtn.style.display = 'flex';
        skipLink.style.display = 'none';
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
        // Show primary photo as first thumb
        if (state.photoDataUrl) {
            const thumb = document.createElement('div');
            thumb.className = 'extra-photo-thumb active';
            thumb.innerHTML = `<img src="${state.photoDataUrl}">`;
            thumb.onclick = () => { previewImg.src = state.photoDataUrl; document.querySelectorAll('.extra-photo-thumb').forEach(t=>t.classList.remove('active')); thumb.classList.add('active'); };
            scroll.appendChild(thumb);
        }
        // Show extra photos
        state.extraPhotos.forEach((ep, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'extra-photo-thumb';
            thumb.innerHTML = `<img src="${ep.dataUrl}"><button class="extra-photo-remove" onclick="event.stopPropagation();removeExtraPhoto(${idx})"><i class="fa-solid fa-xmark"></i></button>`;
            thumb.onclick = () => { previewImg.src = ep.dataUrl; document.querySelectorAll('.extra-photo-thumb').forEach(t=>t.classList.remove('active')); thumb.classList.add('active'); };
            scroll.appendChild(thumb);
        });
    }

    window.removeExtraPhoto = (idx) => {
        state.extraPhotos.splice(idx, 1);
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
                    canvas.toBlob(blob => {
                        state.extraPhotos.push({ dataUrl, blob });
                        _updateExtraPhotoStrip();
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

    // File input handlers (camera fallback and file browse)
    ['file-camera', 'file-browse'].forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    // Adaptive compression based on network speed
                    detectPWANetworkTier();
                    const netCfg = getPWAAdaptiveConfig();
                    const maxDim = netCfg.imageMaxWidth;
                    const quality = netCfg.imageQuality;
                    console.log(`[PWA Photo] Compress: tier=${_pwaTier}, quality=${quality}, maxWidth=${maxDim}`);

                    const canvas = document.createElement('canvas');
                    let w = img.width, h = img.height;
                    if (w > maxDim || h > maxDim) {
                        if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
                        else { w = Math.round(w * maxDim / h); h = maxDim; }
                    }
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);

                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    state.photoDataUrl = dataUrl;
                    showPreview(dataUrl);

                    canvas.toBlob(blob => {
                        state.photoBlob = blob;
                        console.log(`Image compressed: ${Math.round(file.size / 1024)}KB -> ${Math.round(blob.size / 1024)}KB (${_pwaTier})`);
                    }, 'image/jpeg', quality);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
    });

    skipLink.addEventListener('click', () => { state.photoDataUrl = null; goToStage('stage-audio'); });
    nextBtn.addEventListener('click', () => goToStage('stage-audio'));
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

function setupCameraModal() {
    document.getElementById('btn-cam-close').addEventListener('click', () => {
        if (state.cameraStream) { state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; }
        document.getElementById('camera-modal').style.display = 'none';
    });

    document.getElementById('btn-cam-snap').addEventListener('click', () => {
        const video = document.getElementById('camera-stream');
        const canvas = document.getElementById('camera-canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        detectPWANetworkTier();
        const camCfg = getPWAAdaptiveConfig();
        const dataUrl = canvas.toDataURL('image/jpeg', camCfg.imageQuality);
        state.photoDataUrl = dataUrl;

        canvas.toBlob(blob => { state.photoBlob = blob; }, 'image/jpeg', camCfg.imageQuality);

        document.getElementById('photo-preview').src = dataUrl;
        document.getElementById('photo-preview').style.display = 'block';
        document.getElementById('photo-placeholder').style.display = 'none';
        document.getElementById('btn-photo-next').style.display = 'flex';
        document.getElementById('photo-skip-link').style.display = 'none';

        if (state.cameraStream) { state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; }
        document.getElementById('camera-modal').style.display = 'none';
    });
}

// ── STAGE 2: Audio + Speech-to-Text ───────────────────────────────────────────
function setupAudioStage() {
    const micBtn = document.getElementById('btn-mic');
    const micLabel = document.getElementById('mic-label');
    const micIcon = document.getElementById('mic-icon');
    const liveTranscript = document.getElementById('live-transcript');
    const labelText = document.getElementById('transcript-label-text');
    const hintBar = document.getElementById('transcript-hint-bar');
    const recTimer = document.getElementById('rec-timer');
    const timerText = document.getElementById('timer-text');
    const nextBtn = document.getElementById('btn-audio-next');
    const skipLink = document.getElementById('audio-skip-link');

    // ── Set up Web Speech API (Transcription) ──
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let finalTranscript = '';

    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = state.speechCode || 'en-US';

        recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript + ' ';
                else interim = event.results[i][0].transcript;
            }
            liveTranscript.value = finalTranscript + interim;
            state.transcript = liveTranscript.value;
            // Visual feedback: pulse the textarea border while getting speech
            liveTranscript.classList.add('has-text');
            labelText.textContent = '🎤 Listening — text appears live below';
        };

        recognition.onerror = (event) => {
            console.warn('SpeechRecognition error:', event.error, event.message);
            const FATAL = ['not-allowed', 'service-not-allowed'];
            if (FATAL.includes(event.error)) {
                stopRecording();
                micLabel.textContent = 'Microphone blocked — check browser settings and allow access.';
            } else if (event.error === 'network') {
                labelText.textContent = '⚠ Live text needs internet — audio still recording';
                console.warn('Speech API needs network. Audio recording continues.');
            } else if (event.error === 'no-speech') {
                // Normal — just means silence detected, recognition will restart
            } else if (event.error === 'aborted') {
                // Can happen on page transitions, ignore
            } else {
                labelText.textContent = '⚠ Live text unavailable — audio still recording';
            }
        };

        recognition.onstart = () => {
            console.log('SpeechRecognition started, lang:', recognition.lang);
        };

        recognition.onaudiostart = () => {
            console.log('SpeechRecognition: audio capture started');
        };

        recognition.onend = () => {
            console.log('SpeechRecognition ended, isRecording:', state.isRecording);
            if (state.isRecording) {
                setTimeout(() => { try { recognition.start(); } catch(_) {} }, 200);
            }
        };
        state.recognition = recognition;
    } else {
        console.warn("SpeechRecognition not supported in this browser.");
        // Check if it's a secure context issue
        if (!window.isSecureContext) {
            console.warn("Not a secure context (HTTPS required for Speech API). URL:", window.location.href);
            micLabel.textContent = "Audio only — live text needs HTTPS";
            labelText.textContent = '⚠ Live text needs HTTPS — type below or backend will transcribe after submit';
        } else {
            micLabel.textContent = "Audio only (type your message below)";
            labelText.textContent = 'Type your message below';
        }
    }

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
            finalTranscript = '';
            micBtn.classList.add('recording');
            micIcon.className = 'fa-solid fa-stop';
            micLabel.textContent = 'Recording... Tap to Stop';
            labelText.textContent = '🎤 Listening — text appears live below';
            liveTranscript.classList.add('recording-active');
            hintBar.style.display = 'none';

            recTimer.style.display = 'flex';
            state.timerSeconds = 0;
            timerText.textContent = '00:00';
            state.timerInterval = setInterval(() => {
                state.timerSeconds++;
                const m = String(Math.floor(state.timerSeconds / 60)).padStart(2, '0');
                const s = String(state.timerSeconds % 60).padStart(2, '0');
                timerText.textContent = `${m}:${s}`;
            }, 1000);

            if (recognition) {
                try {
                    recognition.start();
                    console.log('SpeechRecognition.start() called successfully');
                } catch(e) {
                    console.warn("STT Start failed:", e.name, e.message);
                    // Show fallback message — audio still records, live text won't work
                    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                        labelText.textContent = '⚠ Live text requires HTTPS — audio still recording, backend will transcribe';
                    } else {
                        labelText.textContent = '⚠ Live text unavailable — audio still recording';
                    }
                }
            } else {
                labelText.textContent = '⚠ Live text not supported — audio still recording, backend will transcribe';
            }
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
        liveTranscript.classList.remove('recording-active');
        labelText.textContent = '✅ Recording done — edit your text below';
        hintBar.style.display = 'flex';

        if (recognition) {
            try { recognition.stop(); } catch(e) {}
        }

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

    skipLink.addEventListener('click', proceedToReview);
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
            locStatus.textContent = '📍 Approximate location';
            locStatus.style.color = 'var(--accent, #f59e0b)';
        } else {
            locStatus.textContent = '✅ Location detected';
            locStatus.style.color = 'var(--green)';
        }
        // Show resolved place name, or "Resolving..." while we fetch it
        if (state.locationName) {
            locCoords.textContent = state.locationName;
        } else {
            locCoords.textContent = 'Resolving location...';
            resolveLocationName(); // async — will update UI when done
        }
    } else {
        locStatus.textContent = '📍 Type your location below';
        locStatus.style.color = 'var(--muted)';
        locCoords.textContent = 'We\'ll find it on the map for you';
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
    locStatus.textContent = '🌐 Getting network location...';
    const ipLoc = await tryIPGeolocation();
    btn.classList.remove('spinning');

    if (ipLoc) {
        state.location = ipLoc;
        state.deviceLocation = { lat: ipLoc.lat, lng: ipLoc.lng };
        populateReview();
    } else {
        // Both GPS and IP geo failed — show helpful message, don't block
        locStatus.textContent = '⚠️ Location unavailable';
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
                suggestionsBox.innerHTML = `<div class="place-no-results"><i class="fa-solid fa-magnifying-glass"></i> No matches — try a shorter or different name</div>`;
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
        if (place.lat && place.lng) {
            state.location = { lat: place.lat, lng: place.lng, acc: 0, is_user_corrected: true };
        } else if (!state.location) {
            state.location = { lat: 0, lng: 0, acc: 0, is_user_corrected: true };
        }
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
    // Category chips
    document.querySelectorAll('.chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.infraType = btn.dataset.type;
        });
    });

    // Severity chips
    document.querySelectorAll('.sev-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sev-chip').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            state.severity = btn.dataset.sev;
        });
    });

    // Location autocomplete (instant offline suggestions after 3 chars)
    setupLocationAutocomplete();

    document.getElementById('btn-review-next').addEventListener('click', () => {
        state.description = document.getElementById('edit-text').value.trim();
        populateSendStage();
        goToStage('stage-send');
    });
}

// ── STAGE 4: Send ──────────────────────────────────────────────────────────────
function populateSendStage() {
    document.getElementById('summary-type').textContent = state.infraType;
    document.getElementById('summary-severity').textContent = state.severity;

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
        const dl = conn.downlink; // Mbps estimate
        if (ect === '4g' && dl > 5)  { _pwaTier = 'FAST'; }
        else if (ect === '4g')       { _pwaTier = 'MEDIUM'; }
        else if (ect === '3g')       { _pwaTier = 'SLOW'; }
        else                         { _pwaTier = 'VERY_SLOW'; }
    }
    console.log(`[PWA Network] Tier: ${_pwaTier}`);
    return _pwaTier;
}

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

async function submitReport() {
    const sendBtn = document.getElementById('btn-send');
    sendBtn.disabled = true;

    try {
        // Generate idempotency key (use shared genUUID() — single source of truth)
        const clientReportId = genUUID();

        const deviceHash = localStorage.getItem('crisp_device_id') || (() => {
            const id = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            localStorage.setItem('crisp_device_id', id);
            return id;
        })();

        const hasPhoto = !!state.photoDataUrl;
        const hasAudio = !!state.audioBlob;
        const extraPhotoCount = state.extraPhotos.length;
        const expectedMedia = (hasPhoto ? 1 : 0) + extraPhotoCount + (hasAudio ? 1 : 0);

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
                    : { latitude: 0, longitude: 0, user_location_name: state.userLocationName || null, device_location_name: null }
            },
            photo: hasPhoto ? state.photoDataUrl : null,
            photoSize: hasPhoto ? (state.photoBlob?.size || 0) : 0,
            extraPhotos: state.extraPhotos.map(ep => ep.dataUrl),
            audioBlob: null,
            audioSize: 0,
            text: state.description || state.transcript || '',
            stages: { meta: false, text: false, photo: !hasPhoto, audio: !hasAudio },
            serverId: null,
            // Stable media IDs for idempotent chunked uploads (PRD §3.3)
            photoMediaId: hasPhoto ? genUUID() : null,
            audioMediaId: hasAudio ? genUUID() : null,
            photoChunkProgress: 0,  // last successfully sent chunk index (for resume)
            audioChunkProgress: 0,
        };

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
        try { await enqueueReport(queueItem); } catch (_) {}
        console.log('Report queued:', clientReportId, 'media expected:', expectedMedia);

        // ── Show success to user IMMEDIATELY — don't wait for network ────────
        showUploadOverlay('Sending report...');
        updateUploadProgress(50, 'Report saved!');
        document.getElementById('report-id-text').textContent = clientReportId.slice(0, 8).toUpperCase();

        // Brief pause so user sees the overlay
        await new Promise(r => setTimeout(r, 800));
        showUploadSuccess();
        setTimeout(() => goToStage('stage-success'), 1200);

        // ── Now try to send in background (non-blocking) ─────────────────────
        trySendQueuedReport(queueItem);

    } catch (fatalErr) {
        console.error('submitReport fatal error:', fatalErr);
        hideUploadOverlay();
        document.getElementById('report-id-text').textContent = 'SAVED';
        goToStage('stage-success');
        sendBtn.disabled = false;
    }
}

// ── Background sender: processes one queued report through all stages ─────────
async function trySendQueuedReport(item) {
    try {
        const stages = item.stages;
        let reportId = item.serverId;

        // Stage 1: Metadata (< 1KB — 15s timeout, 5 retries)
        if (!stages.meta) {
            try {
                const data = await sendWithRetry(`${API_BASE}/reports/meta`, item.meta, 5, 15000);
                reportId = data.id;
                item.serverId = reportId;
                item.stages.meta = true;
                try { await enqueueReport(item); } catch (_) {}
                console.log('Stage 1 (meta) sent:', reportId);
            } catch (e) {
                console.warn('Stage 1 failed, will retry later:', e.message);
                return; // Can't proceed without server ID
            }
        }

        // Stage 2: Text/Description (Tiny, but separate for 1KBPS bursts)
        if (!stages.text && reportId) {
            try {
                await sendWithRetry(`${API_BASE}/reports/${reportId}/description`, {
                    description: item.text || ''
                }, 5, 20000);
                item.stages.text = true;
                try { await enqueueReport(item); } catch (_) {}
                console.log('Stage 2 (text) sent');
            } catch (e) {
                console.warn('Stage 2 failed, will retry later:', e.message);
                // We DON'T return; we can still try to send media if we have a reportId
            }
        }

        // Stage 2: Photo — thumbnail first, then adaptive chunks
        if (!stages.photo && item.photo && reportId) {
            try {
                const mediaId = item.photoMediaId || genUUID();
                item.photoMediaId = mediaId;

                // Detect network tier for adaptive chunk sizing
                detectPWANetworkTier();
                const netConfig = getPWAAdaptiveConfig();
                console.log(`[PWA Upload] Photo: tier=${_pwaTier}, chunkSize=${netConfig.chunkSize}`);

                // Extract pure base64 (strip "data:image/jpeg;base64," prefix)
                const b64 = item.photo.includes(',') ? item.photo.split(',')[1] : item.photo;
                const chunks = chunkBase64(b64, netConfig.chunkSize);
                const total = chunks.length;
                const startSeq = item.photoChunkProgress || 0;

                // Send thumbnail once at the start (gives dashboard an instant preview)
                if (startSeq === 0) {
                    try {
                        const thumb = await generateThumbnail(item.photo);
                        if (thumb) {
                            await sendWithRetry(
                                `${API_BASE}/reports/${reportId}/media/thumbnail`,
                                { media_id: mediaId, thumbnail_data: thumb },
                                3, 15000
                            );
                            console.log('Thumbnail sent for', mediaId);
                        }
                    } catch (e) {
                        console.warn('Thumbnail failed (non-fatal):', e.message);
                    }
                }

                // Send chunks from last known position (resume capability)
                for (let seq = startSeq; seq < total; seq++) {
                    const chunkData = chunks[seq];
                    try {
                        await sendWithRetry(
                            `${API_BASE}/reports/${reportId}/media/chunk`,
                            {
                                media_id: mediaId,
                                type: 'IMAGE',
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
                        throw retryErr; // will be caught by outer catch
                    }
                    item.photoChunkProgress = seq + 1;
                    // Persist progress every 5 chunks so retries can resume mid-file
                    if ((seq + 1) % 5 === 0) {
                        try { await enqueueReport(item); } catch (_) {}
                    }
                }

                item.stages.photo = true;
                item.photo = null; // free memory — all chunks sent
                try { await enqueueReport(item); } catch (_) {}
                console.log(`Photo sent: ${total} chunks (${item.photoSize || '?'} bytes, tier=${_pwaTier})`);
            } catch (e) {
                // Note: item.photo may already be null if error was in post-loop cleanup;
                // use saved progress counter rather than re-computing chunk total
                console.warn(`Photo chunk failed at seq ${item.photoChunkProgress}:`, e.message);
                try { await enqueueReport(item); } catch (_) {} // save progress for resume
                // Don't return — attempt audio independently
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
    document.getElementById('btn-send').addEventListener('click', submitReport);
    document.getElementById('btn-send-back').addEventListener('click', () => goToStage('stage-review'));
    document.getElementById('btn-new-report').addEventListener('click', resetApp);
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

function resetApp() {
    inactivityManager.stop();
    state.photoDataUrl = null; state.photoBlob = null; state.extraPhotos = [];
    state.audioBlob = null; state.transcript = ''; state.description = '';
    state.infraType = 'ROAD'; state.severity = 'MODERATE'; state.isAutoSubmit = false;

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
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('photo-placeholder').style.display = 'flex';
    document.getElementById('btn-photo-next').style.display = 'none';
    document.getElementById('photo-skip-link').style.display = 'block';
    document.getElementById('live-transcript').value = '';
    document.getElementById('live-transcript').classList.remove('has-text', 'recording-active');
    document.getElementById('transcript-label-text').textContent = 'Live Text — speak or type below';
    document.getElementById('transcript-hint-bar').style.display = 'none';
    document.getElementById('edit-text').value = '';
    document.getElementById('btn-send').disabled = false;
    document.getElementById('btn-send').innerHTML = `<i class="fa-solid fa-paper-plane"></i> <span>${t('send_undp')}</span>`;
    goToStage('stage-home');
}

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Setup stage modules first
    setupPhotoStage();
    setupCameraModal();
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

    // 6. Connectivity listeners
    window.addEventListener('online', async () => {
        console.log('Back online — triggering sync');
        startRetryLoop(); // restart retry loop immediately
        updateSyncBadge();
    });

    window.addEventListener('offline', () => {
        // Silently handle offline — user doesn't need to worry
        console.log('Device went offline — reports will queue silently');
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

    // 8. Setup start button
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
