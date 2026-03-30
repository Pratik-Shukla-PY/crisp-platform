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
        tx.objectStore(IDB_STORE).put({
            client_report_id: payload.client_report_id,
            payload,
            timestamp: Date.now(),
            retryCount: 0,
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

            // Stage 2: photo
            if (!stages.photo && item.photo) {
                try {
                    const res = await fetch(`${API_BASE}/reports/${reportId}/media/attach`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'IMAGE', resolution_tier: 'MEDIUM', url: item.photo, file_size_bytes: item.photoSize || 0 })
                    });
                    if (res.ok) { item.stages.photo = true; item.photo = null; try { await enqueueReport(item); } catch (_) {} }
                } catch (_) {}
            }

            // Stage 3: audio
            if (!stages.audio && item.audioBlob) {
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
            if (item.stages.meta && item.stages.photo && item.stages.audio) {
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
        home_title: "Report", home_sub: "Quick & Easy\n4 steps.",
        rs1: "PHOTO", rs2: "VOICE", rs3: "CHECK", rs4: "SEND",
        start_btn: "START",
        s1_title: "PHOTO", s1_sub: "Take picture",
        no_photo: "No photo", use_camera: "Camera", browse: "Files", skip_photo: "Skip", next: "NEXT",
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
        home_title: "रिपोर्ट", home_sub: "सरल और तेज़।\n4 कदम।",
        rs1: "फोटो", rs2: "आवाज़", rs3: "जांचें", rs4: "भेजें",
        start_btn: "शुरू करें",
        s1_title: "फोटो", s1_sub: "चित्र लें",
        no_photo: "नहीं है", use_camera: "कैमरा", browse: "फाइल", skip_photo: "छोड़ें", next: "आगे",
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
    const TO = 6000;
    // Tier 1: ipapi.co — richest data, may rate-limit on shared server IPs but works from browsers
    try {
        const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(TO) });
        if (res.ok) {
            const d = await res.json();
            if (d && d.latitude && d.longitude && !d.error) {
                return { lat: d.latitude, lng: d.longitude, acc: 5000, is_ip_based: true, country: d.country_code, region: d.region };
            }
        }
    } catch (_) {}
    // Tier 2: ipwho.is — free HTTPS, no key required
    try {
        const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(TO) });
        if (res.ok) {
            const d = await res.json();
            if (d && d.latitude && d.longitude && d.success !== false) {
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

// Resolve and cache location name, update UI elements showing it
async function resolveLocationName() {
    if (!state.location || (state.location.lat === 0 && state.location.lng === 0)) return;
    // Don't re-resolve if we already have a name for these coords
    if (state.locationName) return;

    const name = await reverseGeocode(state.location.lat, state.location.lng);
    if (name) {
        state.locationName = name;
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
            activateLang(langCode, speechMap[langCode] || 'en-US');

            document.querySelectorAll('#lang-switcher button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

// ── Dynamic language detection ────────────────────────────────────────────────
// Comprehensive region → { code, label, speechCode } map
// Covers Indian states, ASEAN countries, African states, South American regions, etc.
// Global mapping: ISO 3166-1 alpha-2 -> { code, label, speechCode }
const COUNTRY_LANG_DATA = {
    // Asia
    'IN': { code: 'hi', label: 'हिंदी', speech: 'hi-IN' }, // Default India (states handled separately)
    'MY': { code: 'my', label: 'မြန်မာ', speech: 'my-MM' },
    'BD': { code: 'bn', label: 'বাংলা', speech: 'bn-BD' },
    'PK': { code: 'ur', label: 'اردو', speech: 'ur-PK' },
    'LK': { code: 'si', label: 'සිංහල', speech: 'si-LK' },
    'NP': { code: 'ne', label: 'नेपाली', speech: 'ne-NP' },
    'TH': { code: 'th', label: 'ไทย', speech: 'th-TH' },
    'VN': { code: 'vi', label: 'Tiếng Việt', speech: 'vi-VN' },
    'ID': { code: 'id', label: 'Bahasa', speech: 'id-ID' },
    'PH': { code: 'tl', label: 'Filipino', speech: 'fil-PH' },
    'KH': { code: 'km', label: 'ខ្មែរ', speech: 'km-KH' },
    'CN': { code: 'zh', label: '中文', speech: 'zh-CN' },
    'JP': { code: 'ja', label: '日本語', speech: 'ja-JP' },
    'KR': { code: 'ko', label: '한국어', speech: 'ko-KR' },
    // Africa
    'GH': { code: 'ak', label: 'Akan', speech: 'en-GH' },
    'NG': { code: 'yo', label: 'Yorùbá', speech: 'en-NG' },
    'ET': { code: 'am', label: 'አማርኛ', speech: 'am-ET' },
    'KE': { code: 'sw', label: 'Kiswahili', speech: 'sw-KE' },
    'TZ': { code: 'sw', label: 'Kiswahili', speech: 'sw-TZ' },
    'UG': { code: 'sw', label: 'Kiswahili', speech: 'sw-UG' },
    'EG': { code: 'ar', label: 'عربي', speech: 'ar-EG' },
    'MA': { code: 'ar', label: 'عربي', speech: 'ar-MA' },
    'ZA': { code: 'zu', label: 'isiZulu', speech: 'en-ZA' },
    // South America
    'BR': { code: 'pt', label: 'Português', speech: 'pt-BR' },
    'CO': { code: 'es', label: 'Español', speech: 'es-CO' },
    'AR': { code: 'es', label: 'Español', speech: 'es-AR' },
    'PE': { code: 'es', label: 'Español', speech: 'es-PE' },
    'VE': { code: 'es', label: 'Español', speech: 'es-VE' },
    'CL': { code: 'es', label: 'Español', speech: 'es-CL' },
    'MX': { code: 'es', label: 'Español', speech: 'es-MX' },
    // Middle East
    'SA': { code: 'ar', label: 'عربي', speech: 'ar-SA' },
    'AE': { code: 'ar', label: 'عربي', speech: 'ar-AE' },
    'TR': { code: 'tr', label: 'Türkçe', speech: 'tr-TR' },
    'IR': { code: 'fa', label: 'فارسی', speech: 'fa-IR' },
    // Europe
    'FR': { code: 'fr', label: 'Français', speech: 'fr-FR' },
    'DE': { code: 'de', label: 'Deutsch', speech: 'de-DE' },
    'ES': { code: 'es', label: 'Español', speech: 'es-ES' },
    'IT': { code: 'it', label: 'Italiano', speech: 'it-IT' },
    'RU': { code: 'ru', label: 'Русский', speech: 'ru-RU' },
    'UA': { code: 'uk', label: 'Українська', speech: 'uk-UA' },
    // Europe (More)
    'GB': { code: 'en', label: 'English', speech: 'en-GB' },
    'US': { code: 'en', label: 'English', speech: 'en-US' },
    'CA': { code: 'en', label: 'English', speech: 'en-CA' },
    'AU': { code: 'en', label: 'English', speech: 'en-AU' },
    'NL': { code: 'nl', label: 'Nederlands', speech: 'nl-NL' },
    'PL': { code: 'pl', label: 'Polski', speech: 'pl-PL' },
    'SE': { code: 'sv', label: 'Svenska', speech: 'sv-SE' },
    'NO': { code: 'no', label: 'Norsk', speech: 'no-NO' },
    'DK': { code: 'da', label: 'Dansk', speech: 'da-DK' },
    'FI': { code: 'fi', label: 'Suomi', speech: 'fi-FI' },
    'CH': { code: 'de', label: 'Deutsch', speech: 'de-CH' },
    'AT': { code: 'de', label: 'Deutsch', speech: 'de-AT' },
    'PT': { code: 'pt', label: 'Português', speech: 'pt-PT' },
    // Middle East (More)
    'IQ': { code: 'ar', label: 'عربي', speech: 'ar-IQ' },
    'JO': { code: 'ar', label: 'عربي', speech: 'ar-JO' },
    'KW': { code: 'ar', label: 'عربي', speech: 'ar-KW' },
    'QA': { code: 'ar', label: 'عربي', speech: 'ar-QA' },
    'IL': { code: 'he', label: 'עברית', speech: 'he-IL' },
    // North Africa / Other
    'DZ': { code: 'ar', label: 'عربي', speech: 'ar-DZ' },
    'TN': { code: 'ar', label: 'عربي', speech: 'ar-TN' },
    'LY': { code: 'ar', label: 'عربي', speech: 'ar-LY' },
    'SD': { code: 'ar', label: 'عربي', speech: 'ar-SD' },
    'AF': { code: 'ps', label: 'پښتو', speech: 'ps-AF' },
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
    sw: { home_title: 'Ripoti Tukio', start_btn: 'Anza Ripoti', use_camera: 'Kamera', browse: 'Tafuta', skip_photo: 'Ruka', next: 'Endelea', tap_mic: 'Gonga ili Kurekodi', send_undp: 'Tuma kwa UNDP', sent_title: 'Ripoti Imetumwa!' },
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

    // STARTING STATE: Default to English but don't finalize yet
    // Show a small hint that we are checking location
    const homeTitle = document.querySelector('[data-i18n="home_title"]');
    if (homeTitle) homeTitle.textContent = "Locating...";

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
                // Use IP country/region to set language
                const regionStr = (ipLoc.region || '').toLowerCase();
                for (const entry of REGION_LANG_MAP) {
                    if (entry.match.some(k => regionStr.includes(k))) {
                        showLocalLangBtn(entry.code, entry.label, entry.speech);
                        return;
                    }
                }
                const cc = (ipLoc.country || '').toUpperCase();
                if (COUNTRY_LANG_DATA[cc]) { showLocalLangBtn(COUNTRY_LANG_DATA[cc].code, COUNTRY_LANG_DATA[cc].label, COUNTRY_LANG_DATA[cc].speech); return; }
            }
            activateLang('en');
        });
        return;
    }

    // Set a timeout for GPS so the user isn't stuck forever
    const gpsTimeout = setTimeout(() => {
        if (!state.location && state.lang === 'en') {
            activateLang('en');
        }
    }, 4000);

    navigator.geolocation.getCurrentPosition(async (pos) => {
        clearTimeout(gpsTimeout);
        state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        state.deviceLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        console.log('GPS Fixed:', state.location);
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
                    showLocalLangBtn(entry.code, entry.label, entry.speech);
                    return;
                }
            }
            if (COUNTRY_LANG_DATA[countryCode]) {
                const entry = COUNTRY_LANG_DATA[countryCode];
                showLocalLangBtn(entry.code, entry.label, entry.speech);
                return;
            }
            const browserLang = navigator.language.split('-')[0];
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
            console.log('IP geolocation fallback applied:', ipLoc);
            // Resolve place name in background
            resolveLocationName();
            // Use IP region for language
            const regionStr = (ipLoc.region || '').toLowerCase();
            for (const entry of REGION_LANG_MAP) {
                if (entry.match.some(k => regionStr.includes(k))) {
                    showLocalLangBtn(entry.code, entry.label, entry.speech);
                    return;
                }
            }
            const cc = (ipLoc.country || '').toUpperCase();
            if (COUNTRY_LANG_DATA[cc]) { showLocalLangBtn(COUNTRY_LANG_DATA[cc].code, COUNTRY_LANG_DATA[cc].label, COUNTRY_LANG_DATA[cc].speech); return; }
        }
        activateLang('en');
    }, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
    });
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

    // File input handlers
    ['file-camera', 'file-browse'].forEach(id => {
        document.getElementById(id).addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            state.photoBlob = file;
            const reader = new FileReader();
            reader.onload = (ev) => {
                state.photoDataUrl = ev.target.result;
                showPreview(state.photoDataUrl);
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
        .catch(() => {
            modal.style.display = 'none';
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
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        state.photoDataUrl = dataUrl;

        canvas.toBlob(blob => { state.photoBlob = blob; }, 'image/jpeg', 0.85);

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
                micLabel.textContent = 'Microphone access denied.';
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
    const locUserName = document.getElementById('loc-user-name');
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

    // Show user-typed location name if set
    if (state.userLocationName) {
        locUserName.textContent = `📌 Your location: ${state.userLocationName}`;
        locUserName.style.display = 'block';
    } else {
        locUserName.style.display = 'none';
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
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
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

async function searchAddress() {
    const input = document.getElementById('input-loc-search');
    const query = input.value.trim();
    if (!query) return;

    const btn = document.getElementById('btn-search-loc');

    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';

    // Always store the user-typed name (for backend geocoding if offline)
    state.userLocationName = query;

    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
        const data = await res.json();
        if (data && data.length > 0) {
            const first = data[0];
            state.location = {
                lat: parseFloat(first.lat),
                lng: parseFloat(first.lon),
                acc: 0,
                is_user_corrected: true
            };
            // Use the search query as the display name (user typed it, it resolved)
            state.locationName = query;
        }
        // If no results, we still have the name stored — backend will geocode it
    } catch (e) {
        // Offline — that's fine, the name is stored and backend will resolve it
        console.log('Geocoding offline, will resolve server-side:', query);
        if (!state.location || (state.location.lat === 0 && state.location.lng === 0)) {
            state.location = { lat: 0, lng: 0, acc: 0, is_user_corrected: true };
        }
    } finally {
        btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';
        populateReview();
        input.value = '';
    }
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

    // Search location button
    document.getElementById('btn-search-loc').addEventListener('click', searchAddress);
    document.getElementById('input-loc-search').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') searchAddress();
    });

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

// ── Progressive Upload Helper ────────────────────────────────────────────────
// XHR-based sender with hard timeout. fetch() hangs on slow networks — XHR doesn't.
function sendJSON(url, payload, timeoutMs = 30000) {
    const method = /\/meta$/.test(url) ? 'POST' : 'PATCH';
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
        // Generate idempotency key
        const clientReportId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });

        const deviceHash = localStorage.getItem('crisp_device_id') || (() => {
            const id = 'DEV-' + Math.random().toString(36).substring(2, 10).toUpperCase();
            localStorage.setItem('crisp_device_id', id);
            return id;
        })();

        const hasPhoto = !!state.photoDataUrl;
        const hasAudio = !!state.audioBlob;
        const expectedMedia = (hasPhoto ? 1 : 0) + (hasAudio ? 1 : 0);

        // Build queue item with all data
        const queueItem = {
            client_report_id: clientReportId,
            meta: {
                client_report_id: clientReportId,
                device_hash: deviceHash,
                source: 'APP',
                severity: state.severity,
                infrastructure_type: state.infraType,
                description: state.description || state.transcript || '',
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
                        user_location_name: state.userLocationName || null
                    }
                    : { latitude: 0, longitude: 0, user_location_name: state.userLocationName || null }
            },
            photo: hasPhoto ? state.photoDataUrl : null,
            photoSize: hasPhoto ? (state.photoBlob?.size || 0) : 0,
            audioBlob: null,
            audioSize: 0,
            stages: { meta: false, photo: !hasPhoto, audio: !hasAudio },
            serverId: null
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

        // Stage 2: Photo (60s timeout, 3 retries)
        if (!stages.photo && item.photo && reportId) {
            try {
                await sendWithRetry(`${API_BASE}/reports/${reportId}/media/attach`, {
                    type: 'IMAGE', resolution_tier: 'MEDIUM',
                    url: item.photo, file_size_bytes: item.photoSize || 0
                }, 3, 60000);
                item.stages.photo = true;
                item.photo = null; // free memory
                try { await enqueueReport(item); } catch (_) {}
                console.log('Stage 2 (photo) sent');
            } catch (e) {
                console.warn('Stage 2 (photo) failed, will retry later:', e.message);
            }
        }

        // Stage 3: Audio (90s timeout, 3 retries)
        if (!stages.audio && item.audioBlob && reportId) {
            try {
                await sendWithRetry(`${API_BASE}/reports/${reportId}/media/attach`, {
                    type: 'AUDIO', resolution_tier: 'LOW',
                    url: item.audioBlob, file_size_bytes: item.audioSize || 0
                }, 3, 90000);
                item.stages.audio = true;
                item.audioBlob = null;
                try { await enqueueReport(item); } catch (_) {}
                console.log('Stage 3 (audio) sent');
            } catch (e) {
                console.warn('Stage 3 (audio) failed, will retry later:', e.message);
            }
        }

        // All done?
        if (item.stages.meta && item.stages.photo && item.stages.audio) {
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

            for (const item of items) {
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
    state.photoDataUrl = null; state.photoBlob = null;
    state.audioBlob = null; state.transcript = ''; state.description = '';
    state.infraType = 'ROAD'; state.severity = 'MODERATE'; state.isAutoSubmit = false;
    state.userLocationName = null; state.locationName = null;
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

    // 9. Show home
    goToStage('stage-home');
});
