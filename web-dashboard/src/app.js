// ══════════════════════════════════════════════════════════════════════════════
// CRISP — Crisis Intelligence Control Panel  v3.0
// Hierarchical, decision-focused, scalable dashboard for UN crisis response
// ══════════════════════════════════════════════════════════════════════════════

// ── Security: HTML escaping to prevent XSS ──────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

// ── Auth Gate ────────────────────────────────────────────────────────────────
const _crispToken = localStorage.getItem('crisp_token');
const _crispUser = (() => { try { return JSON.parse(localStorage.getItem('crisp_user')); } catch { return null; } })();
if (!_crispToken && !window.location.pathname.includes('login')) {
    window.location.href = 'login.html';
}

// ── Config ───────────────────────────────────────────────────────────────────
const BACKEND_HOST = `http://${window.location.hostname || 'localhost'}:8000`;
const API = `${BACKEND_HOST}/api/v1/reports`;

// Add Authorization header to all fetch calls + handle 401 → redirect to login
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
    if (_crispToken && typeof url === 'string' && url.includes('/api/')) {
        opts.headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${_crispToken}` };
    }
    return _origFetch.call(this, url, opts).then(res => {
        if (res.status === 401 && typeof url === 'string' && url.includes('/api/')) {
            localStorage.removeItem('crisp_token');
            localStorage.removeItem('crisp_user');
            if (!window.location.pathname.includes('login')) {
                window.location.href = 'login.html';
            }
        }
        return res;
    });
};
const POLL_INTERVAL        = 4000;  // normal polling
const POLL_INTERVAL_ACTIVE = 1200;  // fast polling while any image is uploading
let _pollTimer = null;

// ── State ────────────────────────────────────────────────────────────────────
let allReports = [];
let sortMode = 'impact';
let timeFilterHours = 0; // 0 = show all time (no filter)
let statusFilter = 'active';
let selectedId = null;
const knownIds = new Set();
const liveMarkers = {};
let firstZoomDone = false;

// ── Live Incident Notifications ─────────────────────────────────────────────
let _unseenReports = [];
const _MAX_NOTIFS = 10;
const _seenIds = new Set(JSON.parse(localStorage.getItem('crisp_seen_ids') || '[]'));
let _notifPanelOpen = false;
let _initialLoadDone = false;  // Suppress notifications on first data load
let heatLayer = null;
let clusterGroup = null;
let boundaryLayers = [];
let currentAudio = null;
let treeState = {};
let treeSearchTerm = '';
let priorityZones = new Set(JSON.parse(localStorage.getItem('crisp_priority_zones') || '[]'));

const SEV_SCORE = { CRITICAL: 10, SEVERE: 7, MODERATE: 4, MINOR: 2, UNKNOWN: 1 };
const INFRA_WEIGHTS = { HOSPITAL: 10, POWER_PLANT: 8, POWER: 8, WATER_TREATMENT: 7, WATER: 7, ROAD: 3, BRIDGE: 5, SCHOOL: 4, HOUSE: 2, OTHER: 1 };
const INFRA_ICONS = { HOSPITAL: 'fa-hospital', POWER: 'fa-bolt', WATER: 'fa-droplet', ROAD: 'fa-road', HOUSE: 'fa-house-crack', SCHOOL: 'fa-school', TELECOM: 'fa-tower-cell', GOVERNMENT: 'fa-landmark', OTHER: 'fa-triangle-exclamation' };
const SEV_COLORS = { CRITICAL: '#ef4444', SEVERE: '#f97316', MODERATE: '#eab308', MINOR: '#22c55e', UNKNOWN: '#64748b' };

// ── QRT Queue State ───────────────────────────────────────────────────────────
let viewMode = 'queue'; // 'queue' = triage cards | 'tree' = strategic hierarchy
let cardSortMode = 'priority'; // priority | newest | oldest | severity | type | has_media | confidence | crisis | damage | source
let sectionState = { needs: true, dispatched: false, resolved: false };
// Priority sort: severity first, then infrastructure criticality, then recency
const SEV_PRIORITY = { CRITICAL: 4, SEVERE: 3, MODERATE: 2, MINOR: 1, UNKNOWN: 0 };
const INFRA_CARD_ICONS = {
    HOSPITAL: 'fa-hospital', POWER_PLANT: 'fa-bolt', POWER: 'fa-bolt',
    WATER_TREATMENT: 'fa-droplet', WATER: 'fa-droplet', ROAD: 'fa-road',
    BRIDGE: 'fa-archway', SCHOOL: 'fa-school', HOUSE: 'fa-house-crack',
    TELECOM: 'fa-tower-cell', GOVERNMENT: 'fa-landmark',
    OTHER: 'fa-triangle-exclamation'
};
const CLUSTER_RADIUS_KM = 15; // Merge regions within 15km

// ── Country / Continent Mappings ─────────────────────────────────────────────
const COUNTRY_TO_CONTINENT = {
    "DZ":"AF","AO":"AF","BJ":"AF","BW":"AF","BF":"AF","BI":"AF","CV":"AF","CM":"AF","CF":"AF","TD":"AF","KM":"AF","CD":"AF","CG":"AF","DJ":"AF","EG":"AF","GQ":"AF","ER":"AF","SZ":"AF","ET":"AF","GA":"AF","GM":"AF","GH":"AF","GN":"AF","GW":"AF","CI":"AF","KE":"AF","LS":"AF","LR":"AF","LY":"AF","MG":"AF","MW":"AF","ML":"AF","MR":"AF","MU":"AF","YT":"AF","MA":"AF","MZ":"AF","NA":"AF","NE":"AF","NG":"AF","RE":"AF","RW":"AF","SH":"AF","ST":"AF","SN":"AF","SC":"AF","SL":"AF","SO":"AF","ZA":"AF","SS":"AF","SD":"AF","TZ":"AF","TG":"AF","TN":"AF","UG":"AF","EH":"AF","ZM":"AF","ZW":"AF",
    "AF":"AS","AM":"AS","AZ":"AS","BH":"AS","BD":"AS","BT":"AS","BN":"AS","KH":"AS","CN":"AS","CY":"AS","GE":"AS","HK":"AS","IN":"AS","ID":"AS","IR":"AS","IQ":"AS","IL":"AS","JP":"AS","JO":"AS","KZ":"AS","KP":"AS","KR":"AS","KW":"AS","KG":"AS","LA":"AS","LB":"AS","MO":"AS","MY":"AS","MV":"AS","MN":"AS","MM":"AS","NP":"AS","OM":"AS","PK":"AS","PS":"AS","PH":"AS","QA":"AS","SA":"AS","SG":"AS","LK":"AS","SY":"AS","TW":"AS","TJ":"AS","TH":"AS","TL":"AS","TR":"AS","TM":"AS","UZ":"AS","VN":"AS","YE":"AS",
    "AL":"EU","AD":"EU","AT":"EU","BY":"EU","BE":"EU","BA":"EU","BG":"EU","HR":"EU","CZ":"EU","DK":"EU","EE":"EU","FO":"EU","FI":"EU","FR":"EU","DE":"EU","GI":"EU","GR":"EU","HU":"EU","IS":"EU","IE":"EU","IT":"EU","LV":"EU","LI":"EU","LT":"EU","LU":"EU","MK":"EU","MT":"EU","MD":"EU","MC":"EU","ME":"EU","NL":"EU","NO":"EU","PL":"EU","PT":"EU","RO":"EU","RU":"EU","SM":"EU","RS":"EU","SK":"EU","SI":"EU","ES":"EU","SJ":"EU","SE":"EU","CH":"EU","UA":"EU","GB":"EU","VA":"EU",
    "AI":"NA","AG":"NA","AW":"NA","BS":"NA","BB":"NA","BZ":"NA","BM":"NA","VG":"NA","CA":"NA","KY":"NA","CR":"NA","CU":"NA","CW":"NA","DM":"NA","DO":"NA","SV":"NA","GL":"NA","GD":"NA","GP":"NA","GT":"NA","HT":"NA","HN":"NA","JM":"NA","MQ":"NA","MX":"NA","MS":"NA","KN":"NA","LC":"NA","PM":"NA","VC":"NA","SX":"NA","TT":"NA","TC":"NA","US":"NA",
    "AS":"OC","AU":"OC","CK":"OC","FJ":"OC","PF":"OC","GU":"OC","KI":"OC","MH":"OC","FM":"OC","NR":"OC","NC":"OC","NZ":"OC","NU":"OC","NF":"OC","MP":"OC","PW":"OC","PG":"OC","PN":"OC","WS":"OC","SB":"OC","TK":"OC","TO":"OC","TV":"OC","UM":"OC","VU":"OC","WF":"OC",
    "AR":"SA","BO":"SA","BR":"SA","CL":"SA","CO":"SA","EC":"SA","FK":"SA","GF":"SA","GY":"SA","PY":"SA","PE":"SA","SR":"SA","UY":"SA","VE":"SA",
    "AQ":"AN",
    "AFG":"AS","IND":"AS","USA":"NA","GBR":"EU","FRA":"EU","DEU":"EU","ITA":"EU","ESP":"EU","CAN":"NA","MEX":"NA","BRA":"SA","ARG":"SA","ZAF":"AF","NGA":"AF","KEN":"AF","ETH":"AF","EGY":"AF","DZA":"AF","MAR":"AF","SDN":"AF","SSD":"AF","COD":"AF","UGA":"AF","SOM":"AF","MLI":"AF","NER":"AF","TCD":"AF","CAF":"AF","UKR":"EU","RUS":"EU","CHN":"AS","JPN":"AS","AUS":"OC","NZL":"OC","POL":"EU","CHE":"EU"
};

const ISO2_TO_ISO3 = {"AF":"AFG","AL":"ALB","DZ":"DZA","AD":"AND","AO":"AGO","AG":"ATG","AR":"ARG","AM":"ARM","AU":"AUS","AT":"AUT","AZ":"AZE","BS":"BHS","BH":"BHR","BD":"BGD","BB":"BRB","BY":"BLR","BE":"BEL","BZ":"BLZ","BJ":"BEN","BT":"BTN","BO":"BOL","BA":"BIH","BW":"BWA","BR":"BRA","BN":"BRN","BG":"BGR","BF":"BFA","BI":"BDI","KH":"KHM","CM":"CMR","CA":"CAN","CV":"CPV","CF":"CAF","TD":"TCD","CL":"CHL","CN":"CHN","CO":"COL","KM":"COM","CG":"COG","CD":"COD","CR":"CRI","CI":"CIV","HR":"HRV","CU":"CUB","CY":"CYP","CZ":"CZE","DK":"DNK","DJ":"DJI","DM":"DMA","DO":"DOM","EC":"ECU","EG":"EGY","SV":"SLV","GQ":"GNQ","ER":"ERI","EE":"EST","ET":"ETH","FJ":"FJI","FI":"FIN","FR":"FRA","GA":"GAB","GM":"GMB","GE":"GEO","DE":"DEU","GH":"GHA","GR":"GRC","GD":"GRD","GT":"GTM","GN":"GIN","GW":"GNB","GY":"GUY","HT":"HTI","HN":"HND","HU":"HUN","IS":"ISL","IN":"IND","ID":"IDN","IR":"IRN","IQ":"IRQ","IE":"IRL","IL":"ISR","IT":"ITA","JM":"JAM","JP":"JPN","JO":"JOR","KZ":"KAZ","KE":"KEN","KI":"KIR","KP":"PRK","KR":"KOR","KW":"KWT","KG":"KGZ","LA":"LAO","LV":"LVA","LB":"LBN","LS":"LSO","LR":"LBR","LY":"LBY","LI":"LIE","LT":"LTU","LU":"LUX","MK":"MKD","MG":"MDG","MW":"MWI","MY":"MYS","MV":"MDV","ML":"MLI","MT":"MLT","MH":"MHL","MR":"MRT","MU":"MUS","MX":"MEX","FM":"FSM","MD":"MDA","MC":"MCO","MN":"MNG","ME":"MNE","MA":"MAR","MZ":"MOZ","MM":"MMR","NA":"NAM","NR":"NRU","NP":"NPL","NL":"NLD","NZ":"NZL","NI":"NIC","NE":"NER","NG":"NGA","NO":"NOR","OM":"OMN","PK":"PAK","PW":"PLW","PA":"PAN","PG":"PNG","PY":"PRY","PE":"PER","PH":"PHL","PL":"POL","PT":"PRT","QA":"QAT","RO":"ROU","RU":"RUS","RW":"RWA","KN":"KNA","LC":"LCA","VC":"VCT","WS":"WSM","SM":"SMR","ST":"STP","SA":"SAU","SN":"SEN","RS":"SRB","SC":"SYC","SL":"SLE","SG":"SGP","SK":"SVK","SI":"SVN","SB":"SLB","SO":"SOM","ZA":"ZAF","SS":"SSD","ES":"ESP","LK":"LKA","SD":"SDN","SR":"SUR","SZ":"SWZ","SE":"SWE","CH":"CHE","SY":"SYR","TJ":"TJK","TZ":"TZA","TH":"THA","TL":"TLS","TG":"TGO","TO":"TON","TT":"TTO","TN":"TUN","TR":"TUR","TM":"TKM","TV":"TUV","UG":"UGA","UA":"UKR","AE":"ARE","GB":"GBR","US":"USA","UY":"URY","UZ":"UZB","VU":"VUT","VE":"VEN","VN":"VNM","YE":"YEM","ZM":"ZMB","ZW":"ZWE"};

const CONTINENT_NAMES = { "AF": "Africa", "AS": "Asia", "EU": "Europe", "NA": "North America", "OC": "Oceania", "SA": "South America", "AN": "Antarctica" };
const CONTINENT_CENTERS = { "AF": [0, 20], "AS": [30, 80], "EU": [50, 15], "NA": [40, -100], "OC": [-25, 140], "SA": [-15, -60], "AN": [-82, 0] };
const CONTINENT_ZOOM = { "AF": 3, "AS": 3, "EU": 4, "NA": 3, "OC": 3, "SA": 3, "AN": 3 };

// ── Utilities ────────────────────────────────────────────────────────────────
const getMediaUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http')) return url;
    return `${BACKEND_HOST}/${url.replace(/^\//, '')}`;
};

// ── Phase 1.5 (Apr 2026): BlurHash placeholder rendering ────────────────────
// The backend serves a ~28-char BlurHash string on each Report (field:
// `blurhash`), encoded by the reporter app at capture time and delivered in
// the meta POST (arrives in ~200 ms). Decoding it locally gives us a very
// cheap 40x40 colour-impression bitmap we can slot into the <img src> BEFORE
// any media chunk has uploaded — closing the time-to-first-visual gap from
// "first SMALL variant lands" (~2 s best case) to "meta POST round-trip"
// (~200 ms). The real photo hot-swaps in via `_maybeUpgradeDetailImage` the
// moment a complete variant arrives, so the blurhash is a transient visual
// only.
//
// Caching: decoding a 40x40 image via the 4x3 DCT costs ~1–2 ms — cheap, but
// `selectReport()` and `showIncidentPreview()` can fire many times per poll
// cycle, and the hash is stable for the lifetime of a report. A plain Map
// keyed by hash is fine: the dashboard holds ~36 reports in the feed so
// memory is negligible and no LRU eviction is needed.
const _blurhashCache = new Map();   // hash → dataURL string (or the sentinel `null`)

function blurhashToDataURL(hash, width = 40, height = 40) {
    // Null/invalid hash → no placeholder. Callers fall through to the
    // existing "awaiting media" icon.
    if (!hash || typeof hash !== 'string' || hash.length < 6) return null;
    if (!window.BlurHash || typeof window.BlurHash.decode !== 'function') return null;
    // Memoise by hash (width/height are fixed defaults for all call sites).
    if (_blurhashCache.has(hash)) return _blurhashCache.get(hash);
    try {
        const pixels = window.BlurHash.decode(hash, width, height);
        // Offscreen canvas: no DOM insertion needed, just an ephemeral 2D
        // context to hand the Uint8ClampedArray to. JPEG at q=0.6 because the
        // blurhash bitmap is already lossy/blurred — PNG would be ~4× larger
        // for zero perceptible gain.
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        imgData.data.set(pixels);
        ctx.putImageData(imgData, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        _blurhashCache.set(hash, dataUrl);
        return dataUrl;
    } catch (e) {
        // Malformed hash — cache `null` so we don't re-attempt each render.
        console.warn('[CRISP] blurhash decode failed:', e && e.message);
        _blurhashCache.set(hash, null);
        return null;
    }
}

// ── Guaranteed-delivery: group + pick best variant ─────────────────────────
// A photo_group_id links the three variants (SMALL/MEDIUM/LARGE) of one
// captured photo. `groupPhotos()` folds a flat media[] into an array of
// groups so the gallery strip shows one thumbnail per photo instead of 3.
// `bestVariant(g)` returns the highest-quality complete variant, falling
// back to partial previews if no variant has finished yet. Legacy media
// without a photo_group_id becomes its own one-member group so reports
// queued before this feature shipped still render.
const TIER_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, ORIGINAL: 4 };

// ── Phase 2 (Apr 2026): tier override map ──────────────────────────────────
// Analysts can click SMALL / MEDIUM / LARGE to manually pick which variant
// to view. Once a user has overridden, `_maybeUpgradeDetailImage` must NOT
// auto-upgrade them back to the best tier on the next poll — their
// deliberate pick wins. Keyed by reportId (not group) because the choice
// is a panel-level preference; cleared on panel close / delete.
const _tierOverride = new Map();   // reportId → 'LOW' | 'MEDIUM' | 'HIGH'

function groupPhotos(mediaList) {
    const groups = new Map();
    const loose = [];
    for (const m of (mediaList || [])) {
        if (m.type !== 'IMAGE') continue;
        const gid = m.photo_group_id;
        if (!gid) {
            loose.push({ group_id: null, members: [m] });
            continue;
        }
        if (!groups.has(gid)) groups.set(gid, { group_id: gid, members: [] });
        groups.get(gid).members.push(m);
    }
    return [...groups.values(), ...loose];
}

// Phase 2: Build the 3-button tier switcher for a photo group. Each button
// shows SMALL / MEDIUM / LARGE; complete variants are clickable, pending
// ones show a subtle upload-% tooltip. The button matching `activeTier`
// gets the `.active` class so analysts can see which tier is showing.
// Escapes group_id / report_id for safe inline handlers.
function _buildTierSwitcher(reportId, group, activeTier) {
    const tiers = [
        { tier: 'LOW',    label: 'SMALL'  },
        { tier: 'MEDIUM', label: 'MEDIUM' },
        { tier: 'HIGH',   label: 'LARGE'  },
    ];
    const byTier = Object.fromEntries(group.members.map(m => [m.resolution_tier, m]));
    const gid = (group.group_id || '').replace(/'/g, '');
    const rid = (reportId || '').replace(/'/g, '');
    const btns = tiers.map(({ tier, label }) => {
        const m = byTier[tier];
        const complete = m && m.assembly_status === 'complete' && m.url;
        const pct = m ? Math.round(m.completion_pct || 0) : 0;
        const active = tier === activeTier ? ' active' : '';
        const disabled = complete ? '' : ' disabled';
        const title = complete
            ? `Show ${label} variant`
            : (m ? `${label} — uploading ${pct}%` : `${label} — not available`);
        const onclick = complete
            ? `event.stopPropagation();setDetailImageTier('${rid}','${gid}','${tier}',this)`
            : '';
        return `<button class="dp-tier-btn dp-tier-${tier.toLowerCase()}${active}${disabled}"
                        type="button"
                        ${complete ? '' : 'aria-disabled="true"'}
                        title="${title}"
                        onclick="${onclick}">${label}</button>`;
    }).join('');
    return `<div class="dp-tier-switcher" role="group" aria-label="Image quality">${btns}</div>`;
}

function bestVariant(group) {
    if (!group || !group.members || group.members.length === 0) return null;
    // Prefer the highest-rank COMPLETED variant.
    const complete = group.members
        .filter(m => m.assembly_status === 'complete' && m.url)
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0));
    if (complete.length > 0) {
        const m = complete[0];
        return { src: getMediaUrl(m.url), tier: m.resolution_tier, isFinal: true, mediaId: m.id };
    }
    // No full variant yet — pick the highest partial/thumbnail preview.
    const partials = group.members
        .filter(m => m.thumbnail_url)
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0));
    if (partials.length > 0) {
        const m = partials[0];
        return { src: getMediaUrl(m.thumbnail_url), tier: m.resolution_tier + '-partial', isFinal: false, mediaId: m.id };
    }
    // ── Phase 2.2 (Apr 2026): partial-file rendering ───────────────────────
    // If no variant has emitted a thumbnail yet but the backend has written
    // `<media_id>_partial.jpg` (updated every few chunks during upload), we
    // can show THAT file as an intermediate visual — even ~30% of a JPEG is
    // recognisable. `completion_pct` is the 0..100 progress indicator; any
    // value strictly between 0 and 100 means a partial file is on disk.
    //
    // Cache-buster: append `?p=<floor(completion_pct)>` so a move from e.g.
    // 33% → 66% forces a refetch (new URL), but a micro-tick 33.1% → 33.9%
    // reuses the cached response. Keeps the CDN/etag layer happy while still
    // advancing the visual as chunks land.
    const partialCandidate = group.members
        .filter(m => {
            const pct = m.completion_pct || 0;
            return pct > 0 && pct < 100 && m.id;
        })
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0))[0];
    if (partialCandidate) {
        const pct = partialCandidate.completion_pct || 0;
        const partialUrl = getMediaUrl('static/' + partialCandidate.id + '_partial.jpg')
                         + '?p=' + Math.floor(pct);
        return {
            src: partialUrl,
            tier: (partialCandidate.resolution_tier || 'UNKNOWN') + '-partial',
            isFinal: false,
            mediaId: partialCandidate.id,
        };
    }
    return null;
}

/** Ensure ISO string is treated as UTC if no timezone indicator present */
function ensureUTC(iso) {
    if (!iso) return iso;
    const s = String(iso).trim();
    if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) return s;
    return s + 'Z';
}

function timeAgo(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return 'Just now';
    const diff = (Date.now() - d) / 1000;
    if (diff < 0) return 'Just now';
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) {
        const h = Math.floor(diff / 3600);
        const m = Math.round((diff % 3600) / 60);
        return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
    }
    const days = Math.round(diff / 86400);
    return days === 1 ? '1 day ago' : `${days}d ago`;
}

/** Rich time display for detail panel: "3:45 PM · 2h 15m ago" */
function timeDisplay(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return 'Unknown';
    const localTime = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${localTime} · ${timeAgo(iso)}`;
}

/** Short date format: "Apr 2, 3:45 PM" */
function formatShortDate(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
           d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showToast(msg, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}"></i> ${msg}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── Live Incident Notification System ────────────────────────────────────────

function _addNotification(r) {
    const locName = r.location?.user_location_name || r.location?.device_location_name || 'Unknown location';
    const srcIcons = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'};
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';
    const sevColor = SEV_COLORS[r.severity] || '#64748b';

    const notif = {
        id: r.id,
        type: (r.infrastructure_type || 'OTHER').replace(/_/g, ' '),
        severity: r.severity || 'UNKNOWN',
        location: locName,
        source: r.source || 'APP',
        srcIcon: srcIcons[r.source] || 'fa-mobile-screen-button',
        srcBrand,
        timestamp: r.server_created_at,
    };

    _unseenReports.unshift(notif);
    if (_unseenReports.length > _MAX_NOTIFS) _unseenReports.pop();

    _renderNotifications();

    // Show flash notification below bell — visible for 5 seconds then flies into bell
    _showFlashNotification(notif, sevColor);
}

function _showFlashNotification(n, sevColor) {
    // Remove any existing flash
    document.querySelectorAll('.notif-flash').forEach(el => el.remove());

    const srcLabel = {APP:'Mobile App',ANDROID:'Android',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[n.source] || n.source;

    const flash = document.createElement('div');
    flash.className = 'notif-flash';
    flash.onclick = () => { flash.remove(); dismissNotif(n.id); };
    flash.innerHTML = `
        <div class="notif-flash-icon">🚨</div>
        <div class="notif-flash-title">NEW INCIDENT REPORTED</div>
        <div class="notif-flash-detail">
            <span class="notif-sev" style="background:${sevColor}25;color:${sevColor};font-size:13px;padding:4px 10px;">${n.severity}</span>
            <span style="font-size:16px;font-weight:700;color:#e2e8f0;">${n.type}</span>
        </div>
        <div class="notif-flash-loc"><i class="fa-solid fa-location-dot" style="color:${sevColor};"></i> ${escapeHtml(n.location)}</div>
        <div class="notif-flash-source"><i class="${n.srcBrand} ${n.srcIcon}"></i> via ${srcLabel}</div>
        <div class="notif-flash-hint">Click to view &middot; Auto-dismiss in 5s</div>
    `;
    document.body.appendChild(flash);

    // After 5 seconds: shrink and fly to top-right bell
    setTimeout(() => {
        flash.classList.add('fly-away');
        setTimeout(() => flash.remove(), 800);
    }, 5000);
}

function _renderNotifications() {
    const bell = document.getElementById('notif-bell');
    const countEl = document.getElementById('notif-count');
    const list = document.getElementById('notif-list');
    if (!bell || !countEl || !list) return;

    const count = _unseenReports.length;

    // Update bell badge
    if (count > 0) {
        countEl.textContent = count;
        countEl.style.display = 'flex';
        bell.classList.add('has-new');
    } else {
        countEl.style.display = 'none';
        bell.classList.remove('has-new');
    }

    // Render cards
    if (count === 0) {
        list.innerHTML = '<div class="notif-empty"><i class="fa-solid fa-check-circle"></i> No new incidents</div>';
        return;
    }

    list.innerHTML = _unseenReports.map(n => {
        const sevColor = SEV_COLORS[n.severity] || '#64748b';
        return `<div class="notif-card" onclick="dismissNotif('${n.id}')" style="border-left:3px solid ${sevColor};">
            <div class="notif-card-top">
                <span class="notif-sev" style="background:${sevColor}20;color:${sevColor};">${n.severity}</span>
                <span class="notif-type">${n.type}</span>
                <i class="${n.srcBrand} ${n.srcIcon}" style="color:#64748b;font-size:11px;" title="${n.source}"></i>
            </div>
            <div class="notif-loc"><i class="fa-solid fa-location-dot" style="color:${sevColor};"></i> ${escapeHtml(n.location)}</div>
            <div class="notif-time">${timeAgo(n.timestamp)}</div>
        </div>`;
    }).join('');
}

window.toggleNotifPanel = () => {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    _notifPanelOpen = !_notifPanelOpen;
    panel.style.display = _notifPanelOpen ? 'block' : 'none';
};

window.dismissNotif = (id) => {
    _unseenReports = _unseenReports.filter(n => n.id !== id);
    _seenIds.add(id);
    try { localStorage.setItem('crisp_seen_ids', JSON.stringify([..._seenIds])); } catch(_){}
    _renderNotifications();
    selectReport(id);
    // Close panel if empty
    if (_unseenReports.length === 0) {
        const panel = document.getElementById('notif-panel');
        if (panel) panel.style.display = 'none';
        _notifPanelOpen = false;
    }
};

window.clearAllNotifs = () => {
    _unseenReports.forEach(n => _seenIds.add(n.id));
    _unseenReports = [];
    try { localStorage.setItem('crisp_seen_ids', JSON.stringify([..._seenIds])); } catch(_){}
    _renderNotifications();
    const panel = document.getElementById('notif-panel');
    if (panel) panel.style.display = 'none';
    _notifPanelOpen = false;
};

// Close panel when clicking outside
document.addEventListener('click', (e) => {
    if (_notifPanelOpen && !e.target.closest('.notif-area')) {
        const panel = document.getElementById('notif-panel');
        if (panel) panel.style.display = 'none';
        _notifPanelOpen = false;
    }
});

// ── Spatial Clustering (15km radius) ─────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Clusters reports by proximity — reports within CLUSTER_RADIUS_KM share a region name
function clusterReportsByProximity(reports) {
    const clusters = []; // { center: {lat, lng}, name: string, reports: [] }
    const withLoc = reports.filter(r => r.location);
    const noLoc = reports.filter(r => !r.location);

    for (const r of withLoc) {
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        let matched = null;

        for (const c of clusters) {
            if (haversineKm(lat, lng, c.center.lat, c.center.lng) <= CLUSTER_RADIUS_KM) {
                matched = c;
                break;
            }
        }

        if (matched) {
            matched.reports.push(r);
            // Update center to centroid
            const n = matched.reports.length;
            matched.center.lat = ((matched.center.lat * (n - 1)) + lat) / n;
            matched.center.lng = ((matched.center.lng * (n - 1)) + lng) / n;
        } else {
            clusters.push({ center: { lat, lng }, name: null, reports: [r] });
        }
    }
    return { clusters, noLoc };
}

// Assigns the best available region name to a cluster
function assignClusterName(cluster) {
    // Use the best geocoded name from any report in the cluster
    const names = cluster.reports
        .map(r => r._geo_city || r._geo_town || r._geo_suburb)
        .filter(Boolean);

    if (names.length > 0) {
        // Use most common name
        const freq = {};
        names.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Fallback: use country + approximate coords
    const country = cluster.reports.find(r => r._country)?._country || 'Unknown';
    return `${country} Zone (${cluster.center.lat.toFixed(2)}, ${cluster.center.lng.toFixed(2)})`;
}

// Apply 15km clustering to all reports — sets r._region for each
function applyRegionClustering(reports) {
    const { clusters } = clusterReportsByProximity(reports);
    for (const c of clusters) {
        const name = assignClusterName(c);
        c.name = name;
        for (const r of c.reports) {
            r._cluster_region = name;
            // Only override _region if it's a fallback/generic name
            if (!r._region || r._region === 'Unknown Region' || r._region.endsWith('Strategy Zone')) {
                r._region = name;
            }
        }
    }
}

// ── Hierarchy Logic ──────────────────────────────────────────────────────────
function collectIncidents(data) {
    if (Array.isArray(data)) return data;
    return Object.values(data).flatMap(collectIncidents);
}

function calculateNodeMetrics(data) {
    const incidents = collectIncidents(data);
    const s = { p1: 0, p2: 0, p3: 0, total: incidents.length, latest: 0, impact: 0, infra: 0, confidence: 0, infraTypes: {} };
    incidents.forEach(r => {
        if (r.severity === 'CRITICAL' || r.severity === 'SEVERE') s.p1++;
        else if (r.severity === 'MODERATE') s.p2++;
        else s.p3++;
        const t = new Date(ensureUTC(r.server_created_at)).getTime();
        if (t > s.latest) s.latest = t;
        const sevScore = SEV_SCORE[r.severity] || 1;
        const infraWeight = INFRA_WEIGHTS[r.infrastructure_type] || 1;
        s.impact += sevScore * infraWeight;
        if (infraWeight > 2) s.infra++;
        const itype = r.infrastructure_type || 'OTHER';
        s.infraTypes[itype] = (s.infraTypes[itype] || 0) + 1;
    });
    // Confidence: based on report density and spatial clustering
    if (s.total > 0) {
        const densityBonus = Math.min(s.total * 10, 40);
        const severityBonus = Math.min((s.p1 * 15 + s.p2 * 5), 35);
        const recentBonus = (Date.now() - s.latest < 3600000) ? 25 : (Date.now() - s.latest < 86400000) ? 15 : 5;
        s.confidence = Math.min(densityBonus + severityBonus + recentBonus, 100);
    }
    return s;
}

function buildControlPanelTree(reports) {
    // Flat 2-level tree: Region → Type → Incidents[]
    const tree = {};
    reports.forEach(r => {
        const region = r._region || r._country || r.location?.user_location_name || r.location?.device_location_name || 'Unknown';
        const country = r._country || '';
        const label = country && country !== region ? `${region}, ${country}` : region;
        const type = r.infrastructure_type || 'OTHER';

        if (!tree[label]) tree[label] = {};
        if (!tree[label][type]) tree[label][type] = [];
        tree[label][type].push(r);
    });
    return tree;
}

function getTopHotspots(reports, count = 5) {
    // Group by region, score, return top N
    const regionMap = {};
    reports.forEach(r => {
        const key = `${r._country || 'Unknown'}|${r._region || 'Unknown'}`;
        if (!regionMap[key]) regionMap[key] = { country: r._country || 'Unknown', region: r._region || 'Unknown', continent: r._continent_code, incidents: [] };
        regionMap[key].incidents.push(r);
    });
    return Object.values(regionMap)
        .map(g => ({ ...g, metrics: calculateNodeMetrics(g.incidents) }))
        .sort((a, b) => b.metrics.impact - a.metrics.impact)
        .slice(0, count);
}

function sortNodes(keys, data) {
    return keys.sort((a, b) => {
        const ma = calculateNodeMetrics(data[a]);
        const mb = calculateNodeMetrics(data[b]);
        if (sortMode === 'recent') return mb.latest - ma.latest;
        if (sortMode === 'infra') return mb.infra - ma.infra || mb.impact - ma.impact;
        if (sortMode === 'density') return mb.total - ma.total || mb.impact - ma.impact;
        return mb.impact - ma.impact; // default: impact
    });
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
function metricsHTML(stats, compact = false) {
    const urgency = stats.total > 0 ? (stats.impact / stats.total > 25 ? 'HIGH' : stats.impact / stats.total > 10 ? 'MEDIUM' : 'LOW') : 'LOW';
    const latestStr = stats.latest ? timeAgo(new Date(stats.latest).toISOString()) : '';

    if (compact) {
        return `
            <div class="tree-metrics">
                ${stats.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe">${stats.p1}</span>` : ''}
                ${stats.p2 > 0 ? `<span class="m-badge p2" title="Moderate">${stats.p2}</span>` : ''}
                <span class="m-badge total" title="Total incidents">${stats.total}</span>
                ${stats.confidence > 0 ? `<span class="m-conf" title="Confidence">${stats.confidence}%</span>` : ''}
            </div>`;
    }
    return `
        <div class="tree-metrics">
            ${stats.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe incidents">🔴 ${stats.p1}</span>` : ''}
            ${stats.p2 > 0 ? `<span class="m-badge p2" title="Moderate incidents">🟠 ${stats.p2}</span>` : ''}
            ${stats.p3 > 0 ? `<span class="m-badge p3" title="Low severity">🟡 ${stats.p3}</span>` : ''}
            <span class="m-badge total" title="Total incidents">📍 ${stats.total}</span>
            ${stats.infra > 0 ? `<span class="m-badge infra" title="Critical infrastructure impacted">🏥 ${stats.infra}</span>` : ''}
            ${stats.confidence > 0 ? `<span class="m-conf" title="Confidence score">${stats.confidence}%</span>` : ''}
            ${latestStr ? `<span class="m-time" title="Latest report">⏱ ${latestStr}</span>` : ''}
            <span class="m-score urgency-${urgency}" title="Urgency">${urgency}</span>
        </div>`;
}

function quickActionsHTML(path, level) {
    const isPriority = priorityZones.has(path);
    return `
        <div class="tree-actions">
            <button class="a-btn" onclick="event.stopPropagation(); focusMapOnNode('${path}')" title="View on Map"><i class="fa-solid fa-crosshairs"></i></button>
            <button class="a-btn" onclick="event.stopPropagation(); exportNodeData('${path}')" title="Export Data"><i class="fa-solid fa-file-export"></i></button>
            <button class="a-btn ${isPriority ? 'a-btn-active' : ''}" onclick="event.stopPropagation(); togglePriorityZone('${path}')" title="${isPriority ? 'Remove Priority' : 'Mark Priority Zone'}"><i class="fa-solid fa-flag"></i></button>
        </div>`;
}

function getLevelIcon(levelName, label) {
    const LEVEL_ICONS = {
        continent: { icon: 'fa-earth-americas', tooltip: 'Continent' },
        country: { icon: 'fa-flag', tooltip: 'Country' },
        region: { icon: 'fa-map-location-dot', tooltip: 'Region' },
        type: { icon: INFRA_ICONS[label] || 'fa-triangle-exclamation', tooltip: `Infrastructure: ${label}` },
        severity: { icon: 'fa-gauge-high', tooltip: `Severity: ${label}` },
        status: { icon: 'fa-circle-check', tooltip: `Status: ${label}` }
    };
    const entry = LEVEL_ICONS[levelName] || { icon: 'fa-folder', tooltip: levelName };
    return `<i class="fa-solid ${entry.icon} tree-level-icon" title="${entry.tooltip}"></i>`;
}

function createTreeHeader(label, stats, levelName, path, isExpanded) {
    const div = document.createElement('div');
    div.className = `tree-header level-${levelName}-header ${isExpanded ? 'expanded' : ''}`;
    const isPriority = priorityZones.has(path);

    const useCompact = ['type', 'severity', 'status'].includes(levelName);

    const sevDots = stats.p1 > 0
        ? `<span class="tv-sev-dots">${'🔴'.repeat(Math.min(stats.p1, 3))}${stats.p1 > 3 ? '+' + (stats.p1-3) : ''}</span>`
        : '';

    div.innerHTML = `
        <span class="chevron" title="Expand/Collapse"><i class="fa-solid fa-chevron-right"></i></span>
        ${getLevelIcon(levelName, label)}
        <span class="tree-label">${label}</span>
        <span class="tv-count">${stats.total}</span>
        ${sevDots}
    `;

    div.onclick = (e) => {
        e.stopPropagation();
        toggleTreeNode(path);
    };
    return div;
}

function renderTreeLevel(parentEl, data, levelIndex, currentPath) {
    // Flat 2-level: region (0) → type (1) → incidents
    const levels = ['region', 'type'];
    const levelName = levels[levelIndex];
    if (!levelName) return;

    const keys = Object.keys(data).sort((a, b) => {
        const sa = collectIncidents(data[a]);
        const sb = collectIncidents(data[b]);
        // Sort by critical count desc, then total desc
        const pa = sa.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
        const pb = sb.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
        if (pb !== pa) return pb - pa;
        return sb.length - sa.length;
    });

    keys.forEach(key => {
        const path = currentPath ? `${currentPath}|${key}` : key;
        if (treeState[path] === undefined) treeState[path] = levelIndex === 0; // regions expanded by default
        const expanded = !!treeState[path];
        const stats = calculateNodeMetrics(data[key]);

        const node = document.createElement('div');
        node.className = `tree-node level-${levelName}`;
        node.appendChild(createTreeHeader(key, stats, levelName, path, expanded));

        if (expanded) {
            const content = document.createElement('div');
            content.className = 'tree-content';

            if (levelIndex < levels.length - 1) {
                renderTreeLevel(content, data[key], levelIndex + 1, path);
            } else {
                // Leaf: render incident rows with inline actions
                const incidents = Array.isArray(data[key]) ? data[key] : collectIncidents(data[key]);
                incidents.sort((a, b) => {
                    const sa = SEV_PRIORITY[b.severity] || 0;
                    const sb = SEV_PRIORITY[a.severity] || 0;
                    return sa !== sb ? sa - sb : new Date(b.server_created_at) - new Date(a.server_created_at);
                });
                incidents.forEach(r => content.appendChild(createIncidentRow(r)));
            }
            node.appendChild(content);
        }
        parentEl.appendChild(node);
    });
}

function createIncidentRow(r) {
    const inc = document.createElement('div');
    inc.className = `tree-incident ${selectedId === r.id ? 'selected' : ''}`;
    inc.onclick = (e) => { if (e.target.closest('.tv-act')) return; selectReport(r.id); };

    const desc = (r.ai_analysis?.ai_summary || r.description || r.ai_analysis?.transcription || '').substring(0, 35);
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const srcIcon = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'}[r.source] || 'fa-mobile-screen-button';
    const srcClass = {APP:'qrt-src-app',WHATSAPP:'qrt-src-whatsapp',TELEGRAM:'qrt-src-telegram',SMS:'qrt-src-sms',IVR:'qrt-src-ivr'}[r.source] || 'qrt-src-app';
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';

    inc.innerHTML = `
        <span class="inc-sev-dot sev-dot-${r.severity}"></span>
        <span class="tv-status tv-st-${r.status}">${r.status === 'RESPONDING' || r.status === 'RESOLVED' ? 'HELPED' : r.status === 'FALSE_ALARM' ? 'FALSE' : r.status}</span>
        <span class="tv-desc" title="${(r.description || '').replace(/"/g, '&quot;')}">${desc || 'No description'}</span>
        <span class="tv-meta">
            <span class="tv-time">${timeAgo(r.server_created_at)}</span>
            <span class="qrt-source-badge ${srcClass}" title="${r.source}"><i class="${srcBrand} ${srcIcon}"></i></span>
        </span>
        <span class="tv-actions">
            ${r.status === 'PENDING' || r.status === 'VERIFIED' ? `<button class="tv-act tv-act-dispatch" onclick="event.stopPropagation();patchReport('${r.id}','dispatch')" title="Send Help"><i class="fa-solid fa-hands-helping"></i></button>` : ''}
            ${r.status !== 'FALSE_ALARM' ? `<button class="tv-act tv-act-false" onclick="event.stopPropagation();patchReport('${r.id}','false-alarm')" title="False Alarm"><i class="fa-solid fa-ban"></i></button>` : ''}
            <button class="tv-act tv-act-delete" onclick="event.stopPropagation();if(confirm('Delete?'))deleteReport('${r.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>
    `;

    inc.onmouseenter = (e) => showIncidentPreview(r, e);
    inc.onmouseleave = hideIncidentPreview;
    return inc;
}

function renderHotspots(parentEl, reports) {
    const hotspots = getTopHotspots(reports);
    if (hotspots.length === 0) return;

    const section = document.createElement('div');
    section.className = 'level-hotspots';

    const header = document.createElement('div');
    header.className = 'tree-header hotspot-header';
    header.innerHTML = `
        <i class="fa-solid fa-fire text-critical" title="Global Hotspots"></i>
        <span class="tree-label">TOP ${hotspots.length} GLOBAL HOTSPOTS</span>
        <span class="m-badge p1" title="Critical/Severe incidents">${hotspots.reduce((s, h) => s + h.metrics.p1, 0)}</span>
    `;
    section.appendChild(header);

    const content = document.createElement('div');
    content.className = 'tree-content hotspot-content';

    hotspots.forEach((h, i) => {
        const item = document.createElement('div');
        item.className = 'hotspot-item';
        item.onclick = () => {
            const incs = h.incidents.filter(r => r.location);
            if (incs.length > 0) {
                const bounds = L.latLngBounds(incs.map(r => [r.location.latitude, r.location.longitude]));
                map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 12 });
            }
        };
        item.innerHTML = `
            <div class="hotspot-rank">#${i + 1}</div>
            <div class="hotspot-info">
                <div class="hotspot-name">${h.region}, ${h.country}</div>
                <div class="hotspot-stats">
                    ${h.metrics.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe incidents">${h.metrics.p1}</span>` : ''}
                    ${h.metrics.p2 > 0 ? `<span class="m-badge p2" title="Moderate incidents">${h.metrics.p2}</span>` : ''}
                    <span class="m-badge total" title="Total incidents">${h.metrics.total}</span>
                    <span class="m-score urgency-${h.metrics.impact / h.metrics.total > 25 ? 'HIGH' : h.metrics.impact / h.metrics.total > 10 ? 'MEDIUM' : 'LOW'}" title="Impact score">
                        Score: ${Math.round(h.metrics.impact)}
                    </span>
                    <span class="m-conf" title="Confidence score">${h.metrics.confidence}%</span>
                </div>
            </div>
            <div class="hotspot-actions">
                <button class="a-btn" onclick="event.stopPropagation(); exportNodeDataFromIncidents(${JSON.stringify(h.incidents.map(r => r.id))})" title="Export"><i class="fa-solid fa-file-export"></i></button>
            </div>
        `;
        content.appendChild(item);
    });

    section.appendChild(content);
    parentEl.appendChild(section);
}

function renderFeed() {
    const el = document.getElementById('report-feed-list');
    if (!el) return;
    if (viewMode === 'queue') {
        renderTriageQueue(el);
    } else {
        renderTreeFeed(el);
    }
    updateCommandStats();
    // P3.3 — Progressive disclosure: once the feed is painted, hide any card
    // past the first 50 and wire up a sentinel + IntersectionObserver that
    // reveals the next 50 when the user scrolls near the bottom. Keeps the
    // initial paint under 100 ms even with 1000+ reports in `allReports`.
    _applyProgressiveReveal(el);
}

let _progressiveIO = null;
const _PROGRESSIVE_PAGE_SIZE = 50;
function _applyProgressiveReveal(container) {
    // Disconnect any previous observer so we don't keep stacks from the
    // previous render cycle.
    if (_progressiveIO) { try { _progressiveIO.disconnect(); } catch (_) {} }
    // Flat-scan every visible card within the feed. Cards in different view
    // modes (.qrt-card for queue, .tree-leaf-card for tree) share the
    // *position* of being inside `#report-feed-list`, so select all cards.
    const cards = container.querySelectorAll('.qrt-card, .tree-leaf-card');
    if (cards.length <= _PROGRESSIVE_PAGE_SIZE) return;

    // Hide everything beyond the initial page.
    let visibleCount = _PROGRESSIVE_PAGE_SIZE;
    cards.forEach((c, i) => { if (i >= visibleCount) c.style.display = 'none'; });

    // Add a sentinel div right after the last visible card.
    const sentinel = document.createElement('div');
    sentinel.className = '_feed-sentinel';
    sentinel.style.cssText = 'height:1px;width:100%;';
    cards[visibleCount - 1].parentElement.insertBefore(sentinel, cards[visibleCount].nextSibling);

    _progressiveIO = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const next = Math.min(visibleCount + _PROGRESSIVE_PAGE_SIZE, cards.length);
            for (let i = visibleCount; i < next; i++) cards[i].style.display = '';
            visibleCount = next;
            if (visibleCount >= cards.length) {
                try { _progressiveIO.disconnect(); } catch (_) {}
                sentinel.remove();
                return;
            }
            // Reposition sentinel after the new last-visible card.
            const lastVisible = cards[visibleCount - 1];
            if (lastVisible && lastVisible.parentElement) {
                lastVisible.parentElement.insertBefore(sentinel, lastVisible.nextSibling);
            }
        }
    }, { root: container, rootMargin: '400px 0px', threshold: 0 });
    _progressiveIO.observe(sentinel);
}

// ── Queue Mode: three-bucket triage cards ─────────────────────────────────────
function renderTriageQueue(el) {
    // Apply time filter
    let reports = allReports;
    if (timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        reports = reports.filter(r => new Date(ensureUTC(r.server_created_at)).getTime() > cutoff);
    }

    // Apply pill filter (if user clicked a stat pill)
    if (_activePillFilter === 'critical') {
        reports = reports.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE');
    } else if (_activePillFilter === 'pending') {
        reports = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    } else if (_activePillFilter === 'responding') {
        reports = reports.filter(r => r.status === 'RESPONDING');
    } else if (_activePillFilter === 'resolved') {
        reports = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
    }
    // 'all' or null = no additional filter

    // Three buckets by action status
    const needs      = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    const dispatched = reports.filter(r => r.status === 'RESPONDING');
    const resolved   = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');

    // Sort each bucket based on selected sort mode
    const sorter = getSortFunction();
    [needs, dispatched, resolved].forEach(bucket => bucket.sort(sorter));

    el.innerHTML = '';

    // Empty state
    if (!reports.length) {
        el.innerHTML = `<div class="feed-empty-state">
            <i class="fa-solid fa-satellite-dish"></i>
            <div class="feed-empty-title">${allReports.length === 0 ? 'Awaiting Incidents' : 'No incidents in this time window'}</div>
            <div class="feed-empty-sub">${allReports.length === 0 ? 'Reports from the field will appear here in real-time as they arrive.' : 'Try expanding the time filter above.'}</div>
        </div>`;
        const badge = document.getElementById('feed-count-badge');
        if (badge) badge.textContent = 'All Clear';
        return;
    }

    const frag = document.createDocumentFragment();

    // Show active filter indicator with clear button
    if (_activePillFilter && _activePillFilter !== 'all') {
        const filterBar = document.createElement('div');
        filterBar.className = 'feed-filter-bar';
        filterBar.innerHTML = `<i class="fa-solid fa-filter"></i> Showing: <strong>${_activePillFilter.toUpperCase()}</strong> <button onclick="filterByPill('${_activePillFilter}')" class="filter-clear-btn"><i class="fa-solid fa-xmark"></i> Clear</button>`;
        frag.appendChild(filterBar);
    }

    // Flashing alert if critical incidents are still waiting for response
    const criticals = needs.filter(r => r.severity === 'CRITICAL');
    if (criticals.length > 0) frag.appendChild(createAlertBanner(criticals.length));

    // Three collapsible sections
    frag.appendChild(createQueueSection('needs',      '<i class="fa-solid fa-circle-exclamation"></i> NEEDS HELP', needs,      'qrt-section-needs'));
    frag.appendChild(createQueueSection('dispatched', '<i class="fa-solid fa-hands-helping"></i> HELP SENT', dispatched, 'qrt-section-dispatched'));
    frag.appendChild(createQueueSection('resolved',   '<i class="fa-solid fa-circle-check"></i> CLOSED',     resolved,   'qrt-section-resolved'));

    el.appendChild(frag);
    const _fcb = document.getElementById('feed-count-badge');
    if (_fcb) _fcb.textContent =
        needs.length > 0 ? `${needs.length} Need Response` : 'All Clear';
}

function sortByPriorityDesc(a, b) {
    // 1. Severity (CRITICAL first)
    const ds = (SEV_PRIORITY[b.severity] || 0) - (SEV_PRIORITY[a.severity] || 0);
    if (ds !== 0) return ds;
    // 2. Infrastructure criticality (hospitals, power before roads, houses)
    const dw = (INFRA_WEIGHTS[b.infrastructure_type] || 1) - (INFRA_WEIGHTS[a.infrastructure_type] || 1);
    if (dw !== 0) return dw;
    // 3. Recency (newest first)
    return new Date(b.server_created_at) - new Date(a.server_created_at);
}

// ── Sort Functions ───────────────────────────────────────────────────────────

window.setCardSortMode = function (mode) {
    cardSortMode = mode;
    // Update active state on buttons
    document.querySelectorAll('.sort-opt').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
    document.querySelector('.sort-dropdown')?.classList.remove('open');
    renderFeed();
};

function getSortFunction() {
    // UNDP Appendix-1 labels (April 2026 rename). NO_DAMAGE kept for legacy
    // rows written before the normalisation hook landed.
    const DAMAGE_ORDER = { COMPLETE: 3, PARTIAL: 2, MINIMAL: 1, NO_DAMAGE: 1 };
    const SOURCE_ORDER = { IVR: 6, SMS: 5, TELEGRAM: 4, WHATSAPP: 3, ANDROID: 2, APP: 1 };

    switch (cardSortMode) {
        case 'newest':
            return (a, b) => new Date(b.server_created_at) - new Date(a.server_created_at);
        case 'oldest':
            return (a, b) => new Date(a.server_created_at) - new Date(b.server_created_at);
        case 'severity':
            return (a, b) => {
                const d = (SEV_PRIORITY[b.severity] || 0) - (SEV_PRIORITY[a.severity] || 0);
                return d !== 0 ? d : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'type':
            return (a, b) => {
                const ta = a.infrastructure_type || 'OTHER';
                const tb = b.infrastructure_type || 'OTHER';
                return ta < tb ? -1 : ta > tb ? 1 : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'has_media':
            return (a, b) => {
                const ma = (a.media || []).filter(m => m.assembly_status === 'complete').length;
                const mb = (b.media || []).filter(m => m.assembly_status === 'complete').length;
                return mb - ma || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'confidence':
            return (a, b) => {
                const sa = a.ai_assessment?.confidence_score ?? -1;
                const sb = b.ai_assessment?.confidence_score ?? -1;
                return sb - sa || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'crisis':
            return (a, b) => {
                const ca = a.crisis_type || 'ZZZ';
                const cb = b.crisis_type || 'ZZZ';
                return ca < cb ? -1 : ca > cb ? 1 : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'damage':
            return (a, b) => {
                const da = DAMAGE_ORDER[a.damage_classification] || 0;
                const db2 = DAMAGE_ORDER[b.damage_classification] || 0;
                return db2 - da || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'source':
            return (a, b) => {
                const sa = SOURCE_ORDER[a.source] || 0;
                const sb = SOURCE_ORDER[b.source] || 0;
                return sb - sa || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        default: // 'priority'
            return sortByPriorityDesc;
    }
}

function createAlertBanner(count) {
    const el = document.createElement('div');
    el.className = 'qrt-alert-banner';
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${count} CRITICAL incident${count > 1 ? 's' : ''} — immediate response required`;
    return el;
}

function createQueueSection(key, label, incidents, cssClass) {
    const isOpen = sectionState[key] !== false;
    const sec = document.createElement('div');
    sec.className = `qrt-section ${cssClass}${isOpen ? '' : ' collapsed'}`;

    const header = document.createElement('div');
    header.className = 'qrt-section-header';
    header.innerHTML = `
        <span class="qrt-section-label">${label}</span>
        <span class="qrt-section-count">${incidents.length}</span>
        <i class="fa-solid fa-chevron-down qrt-section-chevron"></i>
    `;
    header.onclick = () => {
        sectionState[key] = !sectionState[key];
        sec.classList.toggle('collapsed');
    };
    sec.appendChild(header);

    const body = document.createElement('div');
    body.className = 'qrt-section-body';
    if (incidents.length === 0) {
        body.innerHTML = `<div class="qrt-empty"><i class="fa-solid fa-circle-check" style="opacity:0.35;"></i> None</div>`;
    } else {
        incidents.forEach(r => body.appendChild(createIncidentCard(r)));
    }
    sec.appendChild(body);
    return sec;
}

function createIncidentCard(r) {
    const card = document.createElement('div');
    card.className = `qrt-card ${selectedId === r.id ? 'selected' : ''}`;
    card.onclick    = () => selectReport(r.id);
    card.onmouseenter = (e) => showIncidentPreview(r, e);
    card.onmouseleave = hideIncidentPreview;

    const sev   = r.severity || 'UNKNOWN';
    const infra = r.infrastructure_type || 'OTHER';
    const icon  = INFRA_CARD_ICONS[infra] || 'fa-triangle-exclamation';

    // WHERE — prefer user-named location, fall back to device name, then coords
    const loc     = r.location;
    const locText = loc?.user_location_name
                 || loc?.device_location_name
                 || (loc ? `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}` : 'Location unknown');

    const imgMedia   = r.media?.find(m => m.type === 'IMAGE');
    const audioMedia = r.media?.find(m => m.type === 'AUDIO');
    const hasImg     = !!imgMedia;
    const hasAudio   = !!audioMedia;
    const imgPct     = imgMedia?.completion_pct ?? (hasImg ? 100 : 0);
    const imgDone    = imgMedia?.assembly_status === 'complete';
    const audioPct   = audioMedia?.completion_pct ?? (hasAudio ? 100 : 0);
    const audioDone  = audioMedia?.assembly_status === 'complete';
    const locDone    = !!(loc?.latitude || loc?.device_latitude);
    const allDone    = (!r.expected_media || r.received_media >= r.expected_media) && locDone;

    // ACTION button — differs by current status
    let actionEl;
    if (r.status === 'PENDING' || r.status === 'VERIFIED') {
        actionEl = `<button class="qrt-dispatch-btn"
            onclick="event.stopPropagation(); patchReport('${r.id}', 'dispatch')">
            <i class="fa-solid fa-hands-helping"></i> SEND HELP
        </button>`;
    } else if (r.status === 'RESPONDING' || r.status === 'RESOLVED') {
        actionEl = `<span class="qrt-dispatched-label"><i class="fa-solid fa-circle-check"></i> Help Sent</span>`;
    } else {
        actionEl = `<span class="qrt-resolved-label"><i class="fa-solid fa-ban"></i> False</span>`;
    }

    // Truth score badge — shown if verification has been run
    const v = r.verification;
    let truthBadge = '';
    if (v && v.total_score !== undefined) {
        const score   = v.total_score;
        const verdict = v.verdict || 'UNVERIFIED';
        const badgeClass = score >= 80 ? 'truth-strong'
                         : score >= 60 ? 'truth-likely'
                         : score >= 40 ? 'truth-partial'
                         : score >= 20 ? 'truth-low'
                         :               'truth-unverified';
        const truthIcon = score >= 60 ? 'fa-satellite' : 'fa-triangle-exclamation';
        truthBadge = `<span class="qrt-truth-badge ${badgeClass}" title="${verdict.replace(/_/g,' ')}">
            <i class="fa-solid ${truthIcon}"></i> ${score}
        </span>`;
    }

    card.innerHTML = `
        <div class="qrt-sev-strip strip-${sev}"></div>
        <div class="qrt-card-body">
            <div class="qrt-what">
                <div class="qrt-infra-icon"><i class="fa-solid ${icon}"></i></div>
                <span class="qrt-infra-name">${infra.replace(/_/g, ' ')}</span>
                <span class="qrt-sev-badge qrt-sev-${sev}">${sev}</span>
                <span class="qrt-source-badge qrt-src-${(r.source || 'APP').toLowerCase()}" title="Source: ${{APP:'Mobile App',ANDROID:'Android App',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[r.source] || 'Mobile App'}">${{APP:'<i class="fa-solid fa-mobile-screen-button"></i>',ANDROID:'<i class="fa-solid fa-robot"></i>',WHATSAPP:'<i class="fa-brands fa-whatsapp"></i>',TELEGRAM:'<i class="fa-brands fa-telegram"></i>',SMS:'<i class="fa-solid fa-comment-sms"></i>',IVR:'<i class="fa-solid fa-phone"></i>'}[r.source] || '<i class="fa-solid fa-mobile-screen-button"></i>'}</span>
            </div>
            ${r.crisis_type || r.damage_classification ? `<div class="qrt-undp-tags">
                ${r.crisis_type ? `<span class="qrt-tag qrt-tag-crisis">${r.crisis_type.replace(/_/g,' ')}</span>` : ''}
                ${r.damage_classification ? `<span class="qrt-tag qrt-tag-dmg-${r.damage_classification}">${r.damage_classification.replace(/_/g,' ')}</span>` : ''}
            </div>` : ''}
            <div class="qrt-where">
                <i class="fa-solid fa-location-dot"></i>
                <span class="qrt-where-text" title="${locText}">${locText}</span>
            </div>
            <div class="qrt-when">
                <i class="fa-regular fa-clock"></i>
                ${timeAgo(r.server_created_at)}
            </div>
            <div class="qrt-data-progress">
                <span class="qrt-di ${locDone ? 'di-done' : 'di-off'}" title="Location: ${locDone ? 'Received' : 'Missing'}">
                    <i class="fa-solid fa-location-dot"></i>
                </span>
                <span class="qrt-di ${imgDone ? 'di-done' : hasImg ? 'di-partial' : 'di-off'}" title="Image: ${imgDone ? 'Complete' : hasImg ? Math.round(imgPct) + '%' : 'Not received'}">
                    <i class="fa-solid fa-camera"></i>
                    ${hasImg && !imgDone ? `<span class="di-pct">${Math.round(imgPct)}%</span>` : ''}
                </span>
                <span class="qrt-di ${audioDone ? 'di-done' : hasAudio ? 'di-partial' : 'di-off'}" title="Audio: ${audioDone ? 'Complete' : hasAudio ? Math.round(audioPct) + '%' : 'Not received'}">
                    <i class="fa-solid fa-microphone"></i>
                    ${hasAudio && !audioDone ? `<span class="di-pct">${Math.round(audioPct)}%</span>` : ''}
                </span>
                ${v ? `<span class="qrt-ai-badge" title="Verified: ${v.total_score}/100 — ${(v.verdict || '').replace(/_/g,' ')}" style="color:${v.total_score >= 60 ? '#22c55e' : v.total_score >= 40 ? '#eab308' : '#ef4444'};">
                    <i class="fa-solid fa-brain"></i> ${v.total_score}
                </span>` : ''}
            </div>
            <div class="qrt-card-footer">
                ${truthBadge}
                ${actionEl}
            </div>
        </div>
    `;
    return card;
}

window.setViewMode = function(mode) {
    viewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.view-btn[data-mode="${mode}"]`)?.classList.add('active');
    // Show/hide tree-specific controls
    const tc = document.getElementById('tree-controls');
    if (tc) tc.style.display = mode === 'tree' ? '' : 'none';
    // Show/hide sort dropdown (queue mode only)
    const sd = document.getElementById('sort-dropdown');
    if (sd) sd.style.display = mode === 'queue' ? '' : 'none';
    renderFeed();
};

// ── Tree Mode: original hierarchical feed ─────────────────────────────────────
function renderTreeFeed(el) {
    // Filter by status
    let filtered = allReports.filter(r => {
        if (statusFilter === 'all') return true;
        const s = r.status;
        if (statusFilter === 'active') return s === 'PENDING' || s === 'VERIFIED';
        return s.toLowerCase() === statusFilter.toLowerCase();
    });
    // Filter by time
    if (timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        filtered = filtered.filter(r => new Date(ensureUTC(r.server_created_at)).getTime() > cutoff);
    }
    // Filter by search
    if (treeSearchTerm) {
        filtered = filtered.filter(r => {
            const haystack = [
                r.description, r.infrastructure_type, r.severity, r.status, r.source,
                r.location?.user_location_name, r.location?.device_location_name,
                r._region, r._country, r.ai_analysis?.transcription, r.ai_analysis?.ai_summary,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(treeSearchTerm);
        });
    }
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    const tree = buildControlPanelTree(filtered);
    renderTreeLevel(frag, tree, 0, '');
    el.appendChild(frag);
    const _fcb = document.getElementById('feed-count-badge');
    if (_fcb) _fcb.textContent = `${filtered.length} Active`;
    // Update status tab highlights
    document.querySelectorAll('.stab').forEach(btn => btn.classList.remove('active'));
    const activeTab = document.getElementById(`stab-${statusFilter}`);
    if (activeTab) activeTab.classList.add('active');
}

/** Get the time-filtered report set (shared by stats, analytics, and map) */
function _getFilteredReports() {
    let reports = allReports;
    if (timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        reports = reports.filter(r => new Date(ensureUTC(r.server_created_at)).getTime() > cutoff);
    }
    return reports;
}

function updateCommandStats() {
    const reports = _getFilteredReports();
    let critical = 0, responding = 0, resolved = 0, pending = 0;

    reports.forEach(r => {
        if (r.severity === 'CRITICAL' || r.severity === 'SEVERE') critical++;
        if (r.status === 'RESPONDING') responding++;
        if (r.status === 'RESOLVED' || r.status === 'FALSE_ALARM') resolved++;
        if (r.status === 'PENDING' || r.status === 'VERIFIED') pending++;
    });

    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    _set('count-critical', critical);
    _set('count-pending', pending);
    _set('count-responding', responding);
    _set('count-resolved', resolved);
    _set('count-total', reports.length);

    // Average wait time of pending reports
    const pendingReports = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    if (pendingReports.length > 0) {
        const avgWaitMs = pendingReports.reduce((s, r) => s + (Date.now() - new Date(ensureUTC(r.server_created_at)).getTime()), 0) / pendingReports.length;
        const avgMin = Math.round(avgWaitMs / 60000);
        _set('count-avg-response', avgMin < 60 ? `${avgMin}m` : `${Math.floor(avgMin/60)}h${avgMin%60 > 0 ? ' ' + avgMin%60 + 'm' : ''}`);
    } else {
        _set('count-avg-response', '✓');
    }

    // Pulse critical pill when there are critical incidents pending
    const critEl = document.getElementById('stat-critical');
    if (critEl) critEl.classList.toggle('pulse-attention', critical > 0 && pending > 0);

    // Update analytics if panel is open
    if (document.getElementById('analytics-panel')?.style.display !== 'none') _renderAnalytics();
}

// ── Clickable pill filter: click a stat pill to filter the feed ──
let _activePillFilter = null;

window.filterByPill = function (type) {
    // Toggle: click same pill again to clear filter
    if (_activePillFilter === type) {
        _activePillFilter = null;
    } else {
        _activePillFilter = type;
    }
    // Highlight active pill
    document.querySelectorAll('.clickable-pill').forEach(p => p.classList.remove('pill-active'));
    if (_activePillFilter) {
        const activeEl = document.querySelector(`.stat-pill.${_activePillFilter === 'all' ? 'total' : _activePillFilter}`);
        if (activeEl) activeEl.classList.add('pill-active');
    }
    renderFeed();
};

window.toggleAnalytics = function () {
    const panel = document.getElementById('analytics-panel');
    if (!panel) return;
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    if (show) _renderAnalytics();
};

function _calcTeamScore(reports) {
    if (!reports.length) return { score: 0, breakdown: {} };
    const total = reports.length;
    // 1. Response rate (0-30 pts): % of reports that have been dispatched or resolved
    const acted = reports.filter(r => r.status === 'RESPONDING' || r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const responseScore = Math.round((acted / total) * 30);
    // 2. Critical resolution (0-25 pts): % of critical/severe incidents resolved
    const criticals = reports.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE');
    const critResolved = criticals.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const critScore = criticals.length > 0 ? Math.round((critResolved / criticals.length) * 25) : 25;
    // 3. Verification coverage (0-20 pts): % of reports verified with satellite
    const verified = reports.filter(r => r.verification).length;
    const verifyScore = Math.round((verified / total) * 20);
    // 4. Data completeness (0-15 pts): avg media received / expected
    let completeness = 0;
    reports.forEach(r => { if (r.expected_media > 0) completeness += (r.received_media || 0) / r.expected_media; else completeness += 1; });
    const dataScore = Math.round((completeness / total) * 15);
    // 5. False alarm detection (0-10 pts): identifying false alarms shows good triage
    const falseAlarms = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const faScore = Math.min(10, falseAlarms * 2);
    const score = Math.min(100, responseScore + critScore + verifyScore + dataScore + faScore);
    return { score, breakdown: { response: responseScore, critical: critScore, verification: verifyScore, data: dataScore, triage: faScore } };
}

function _renderAnalytics() {
  try {
    const reports = _getFilteredReports();
    if (!reports.length) return;

    // ── KPI Cards (Plecto-style hero metrics) ──
    const dateEl = document.getElementById('ac-kpi-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

    const pendingR = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    const critPending = pendingR.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
    const el1 = document.getElementById('kpi-pending');
    if (el1) el1.textContent = pendingR.length;
    const sub1 = document.getElementById('kpi-pending-sub');
    if (sub1) sub1.innerHTML = critPending > 0 ? `<span class="down"><i class="fa-solid fa-arrow-up"></i> ${critPending} critical/severe</span>` : '<span class="up">No critical pending</span>';

    // Avg wait time of pending reports
    if (pendingR.length > 0) {
        const avgMs = pendingR.reduce((s, r) => s + (Date.now() - new Date(ensureUTC(r.server_created_at)).getTime()), 0) / pendingR.length;
        const hrs = Math.floor(avgMs / 3600000);
        const mins = Math.floor((avgMs % 3600000) / 60000);
        const el2 = document.getElementById('kpi-avg-wait');
        if (el2) el2.textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        const sub2 = document.getElementById('kpi-wait-sub');
        if (sub2) sub2.innerHTML = avgMs > 3600000 ? '<span class="down"><i class="fa-solid fa-arrow-up"></i> Over 1 hour</span>' : '<span class="up"><i class="fa-solid fa-arrow-down"></i> Under 1 hour</span>';
    } else {
        const el2 = document.getElementById('kpi-avg-wait');
        if (el2) el2.textContent = '00:00';
        const sub2 = document.getElementById('kpi-wait-sub');
        if (sub2) sub2.innerHTML = '<span class="up">All responded</span>';
    }

    const resolvedR = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
    const el3 = document.getElementById('kpi-resolved');
    if (el3) el3.textContent = resolvedR.length;
    const sub3 = document.getElementById('kpi-resolved-sub');
    if (sub3) sub3.innerHTML = `of ${reports.length} total`;

    const acted = reports.filter(r => r.status === 'RESPONDING' || r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const rate = reports.length > 0 ? Math.round((acted / reports.length) * 100) : 0;
    const el4 = document.getElementById('kpi-response-rate');
    if (el4) el4.textContent = rate + '%';
    const sub4 = document.getElementById('kpi-rate-sub');
    if (sub4) sub4.innerHTML = rate >= 80 ? '<span class="up"><i class="fa-solid fa-arrow-up"></i> Strong</span>' : rate >= 50 ? 'Moderate' : '<span class="down"><i class="fa-solid fa-arrow-down"></i> Needs attention</span>';

    const falseAlarms = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const faRate = reports.length > 0 ? Math.round((falseAlarms / reports.length) * 100) : 0;
    const el5 = document.getElementById('kpi-false-rate');
    if (el5) el5.textContent = faRate + '%';
    const sub5 = document.getElementById('kpi-false-sub');
    if (sub5) sub5.innerHTML = `${falseAlarms} of ${reports.length} reports`;

    // 0. Team Performance Score (hero)
    const ts = _calcTeamScore(reports);
    const sc = ts.score;
    const scColor = sc >= 80 ? '#22c55e' : sc >= 60 ? '#86efac' : sc >= 40 ? '#eab308' : sc >= 20 ? '#f97316' : '#ef4444';
    const scLabel = sc >= 80 ? 'Excellent' : sc >= 60 ? 'Good' : sc >= 40 ? 'Fair' : sc >= 20 ? 'Needs Improvement' : 'Critical';
    const C = 251.33; // r=40, circumference
    const scOffset = C - (sc / 100) * C;
    const _tsr = document.getElementById('team-score-ring');
    if (_tsr) _tsr.innerHTML = `
        <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
            <circle cx="48" cy="48" r="40" fill="none" stroke="${scColor}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${C}" stroke-dashoffset="${scOffset}" transform="rotate(-90 48 48)" style="transition:stroke-dashoffset 0.8s ease;"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
            <span style="font-size:28px;font-weight:800;color:${scColor};font-family:var(--font-head);line-height:1;">${sc}</span>
            <span style="font-size:10px;color:var(--text-dim);">/100</span>
        </div>`;
    if (_tsr) _tsr.style.position = 'relative';

    const bd = ts.breakdown;
    const _tsd = document.getElementById('team-score-details');
    if (_tsd) _tsd.innerHTML = `
        <div style="font-size:18px;font-weight:800;color:${scColor};font-family:var(--font-head);margin-bottom:4px;">${scLabel}</div>
        <div style="font-size:12px;color:var(--text-sub);margin-bottom:8px;">Team Performance Score — based on response speed, critical resolution, verification coverage, and data quality</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span class="ac-score-chip">Response ${bd.response}/30</span>
            <span class="ac-score-chip">Critical ${bd.critical}/25</span>
            <span class="ac-score-chip">Verified ${bd.verification}/20</span>
            <span class="ac-score-chip">Data ${bd.data}/15</span>
            <span class="ac-score-chip">Triage ${bd.triage}/10</span>
        </div>`;

    // 0b. Score Trend (daily — store in localStorage)
    const TREND_KEY = 'crisp_score_trend';
    const today = new Date().toISOString().slice(0, 10);
    let trend = {};
    try { trend = JSON.parse(localStorage.getItem(TREND_KEY) || '{}'); } catch (_) {}
    trend[today] = sc;
    // Keep last 14 days
    const trendDays = Object.keys(trend).sort().slice(-14);
    const cleanTrend = {};
    trendDays.forEach(d => { cleanTrend[d] = trend[d]; });
    try { localStorage.setItem(TREND_KEY, JSON.stringify(cleanTrend)); } catch (_) {}

    const trendMax = Math.max(...Object.values(cleanTrend), 100);
    const trendEntries = Object.entries(cleanTrend);
    const _stc = document.getElementById('score-trend-chart');
    if (_stc) _stc.innerHTML = `
        <div class="ac-timeline-bars" style="height:50px;">
            ${trendEntries.map(([day, val]) => {
                const dayLabel = day.slice(5); // MM-DD
                const col = val >= 80 ? '#22c55e' : val >= 60 ? '#86efac' : val >= 40 ? '#eab308' : val >= 20 ? '#f97316' : '#ef4444';
                return `<div class="ac-tbar" style="height:${Math.max(4, (val/trendMax)*100)}%;background:linear-gradient(to top,${col}66,${col});" title="${day}: ${val}/100">
                    <span class="ac-tbar-val">${val}</span>
                </div>`;
            }).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:4px;">
            ${trendEntries.length > 1 ? `<span>${trendEntries[0][0].slice(5)}</span><span>${trendEntries[trendEntries.length-1][0].slice(5)}</span>` : '<span>Today</span>'}
        </div>`;

    // 1. Severity Distribution
    const sevCounts = { CRITICAL: 0, SEVERE: 0, MODERATE: 0, MINOR: 0 };
    reports.forEach(r => { if (sevCounts[r.severity] !== undefined) sevCounts[r.severity]++; });
    const maxSev = Math.max(...Object.values(sevCounts), 1);
    const sevColors = { CRITICAL: '#ef4444', SEVERE: '#f97316', MODERATE: '#eab308', MINOR: '#22c55e' };
    const _sdEl = document.getElementById('sev-dist-bars');
    if (_sdEl) _sdEl.innerHTML = Object.entries(sevCounts).map(([k, v]) =>
        `<div class="ac-bar-row">
            <span class="ac-bar-label">${k}</span>
            <div class="ac-bar-track"><div class="ac-bar-fill" style="width:${(v/maxSev)*100}%;background:${sevColors[k]};"></div></div>
            <span class="ac-bar-val">${v}</span>
        </div>`
    ).join('');

    // 2. Infrastructure Breakdown
    const infraCounts = {};
    reports.forEach(r => { infraCounts[r.infrastructure_type] = (infraCounts[r.infrastructure_type] || 0) + 1; });
    const infraSorted = Object.entries(infraCounts).sort((a, b) => b[1] - a[1]);
    const maxInfra = Math.max(...infraSorted.map(e => e[1]), 1);
    const _idEl = document.getElementById('infra-dist-bars');
    if (_idEl) _idEl.innerHTML = infraSorted.map(([k, v]) =>
        `<div class="ac-bar-row">
            <span class="ac-bar-label">${k}</span>
            <div class="ac-bar-track"><div class="ac-bar-fill" style="width:${(v/maxInfra)*100}%;background:var(--info);"></div></div>
            <span class="ac-bar-val">${v}</span>
        </div>`
    ).join('');

    // 3. Response Metrics (use rm_ prefix to avoid variable shadowing with KPI section)
    const rm_pending = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED').length;
    const rm_dispatched = reports.filter(r => r.status === 'RESPONDING').length;
    const rm_done = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const rm_fa = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const rm_rate = reports.length > 0 ? Math.round(((rm_dispatched + rm_done) / reports.length) * 100) : 0;
    const avgMedia = reports.length > 0 ? (reports.reduce((s, r) => s + (r.received_media || 0), 0) / reports.length).toFixed(1) : 0;
    const _rmEl = document.getElementById('response-metrics');
    if (_rmEl) _rmEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:#ef4444;">${rm_pending}</span><span class="ac-metric-label">Awaiting</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#a78bfa;">${rm_dispatched}</span><span class="ac-metric-label">Help Sent</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#10b981;">${rm_done}</span><span class="ac-metric-label">Closed</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${rm_rate}%</span><span class="ac-metric-label">Response Rate</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#f59e0b;">${rm_fa}</span><span class="ac-metric-label">False Alarms</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#94a3b8;">${avgMedia}</span><span class="ac-metric-label">Avg Media/Report</span></div>
    `;

    // 4. Timeline (last 24h, binned by hour)
    const now = Date.now();
    const hours = Array(24).fill(0);
    reports.forEach(r => {
        const h = Math.floor((now - new Date(ensureUTC(r.server_created_at)).getTime()) / 3600000);
        if (h >= 0 && h < 24) hours[23 - h]++;
    });
    const maxH = Math.max(...hours, 1);
    const _tcEl = document.getElementById('timeline-chart');
    if (_tcEl) _tcEl.innerHTML = `
        <div class="ac-timeline-bars">
            ${hours.map((v, i) => `<div class="ac-tbar" style="height:${Math.max(2, (v/maxH)*100)}%;" title="${24 - i}h ago: ${v} incidents"><span class="ac-tbar-val">${v || ''}</span></div>`).join('')}
        </div>
        <div class="ac-timeline-labels"><span>24h ago</span><span>Now</span></div>
    `;

    // 5. Top Affected Regions
    const regionCounts = {};
    reports.forEach(r => {
        const name = r.location?.user_location_name || r.location?.device_location_name || r._region || 'Unknown';
        const short = name.split(',')[0].trim();
        regionCounts[short] = (regionCounts[short] || 0) + 1;
    });
    const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const _trEl = document.getElementById('top-regions');
    if (_trEl) _trEl.innerHTML = topRegions.map(([name, count], i) =>
        `<div class="ac-list-row">
            <span class="ac-list-rank">${i + 1}</span>
            <span class="ac-list-name">${name}</span>
            <span class="ac-list-count">${count}</span>
        </div>`
    ).join('') || '<div style="color:var(--text-dim);font-size:12px;">No location data</div>';

    // 6. Verification Summary
    const verified = reports.filter(r => r.verification).length;
    const unverified = reports.length - verified;
    const avgScore = verified > 0 ? Math.round(reports.filter(r => r.verification).reduce((s, r) => s + (r.verification.total_score || 0), 0) / verified) : 0;
    const highConf = reports.filter(r => r.verification && r.verification.total_score >= 60).length;
    const lowConf = reports.filter(r => r.verification && r.verification.total_score < 40).length;
    const _vsEl = document.getElementById('verify-summary');
    if (_vsEl) _vsEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:#22c55e;">${verified}</span><span class="ac-metric-label">Verified</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#64748b;">${unverified}</span><span class="ac-metric-label">Unverified</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${avgScore}</span><span class="ac-metric-label">Avg Score</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#22c55e;">${highConf}</span><span class="ac-metric-label">High Conf</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#ef4444;">${lowConf}</span><span class="ac-metric-label">Low Conf</span></div>
    `;

    // 7. Data Quality Metrics
    const withPhoto = reports.filter(r => r.media?.some(m => m.type === 'IMAGE' && m.assembly_status === 'complete')).length;
    const withAudio = reports.filter(r => r.media?.some(m => m.type === 'AUDIO' && m.assembly_status === 'complete')).length;
    const withLocation = reports.filter(r => r.location && (r.location.latitude || r.location.device_latitude)).length;
    const withTranscript = reports.filter(r => r.ai_analysis?.transcription).length;
    const withDescription = reports.filter(r => r.description && r.description.trim().length > 0).length;
    const photoPct = reports.length > 0 ? Math.round((withPhoto / reports.length) * 100) : 0;
    const audioPct = reports.length > 0 ? Math.round((withAudio / reports.length) * 100) : 0;
    const locPct = reports.length > 0 ? Math.round((withLocation / reports.length) * 100) : 0;
    const dqEl = document.getElementById('data-quality-metrics');
    if (dqEl) dqEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:${photoPct >= 80 ? '#22c55e' : photoPct >= 50 ? '#eab308' : '#ef4444'};">${photoPct}%</span><span class="ac-metric-label">Have Photos</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:${audioPct >= 80 ? '#22c55e' : audioPct >= 50 ? '#eab308' : '#ef4444'};">${audioPct}%</span><span class="ac-metric-label">Have Audio</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:${locPct >= 90 ? '#22c55e' : '#eab308'};">${locPct}%</span><span class="ac-metric-label">Have GPS</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${withTranscript}</span><span class="ac-metric-label">Transcribed</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#94a3b8;">${withDescription}</span><span class="ac-metric-label">Have Text</span></div>
    `;
  } catch (e) { console.warn('[CRISP] Analytics render error:', e); }
}

// ── Incident Preview (Hover Tooltip) ─────────────────────────────────────────
function showIncidentPreview(r, event) {
    let p = document.getElementById('fast-preview');
    if (!p) {
        p = document.createElement('div');
        p.id = 'fast-preview';
        p.className = 'glass-panel fast-preview-tooltip';
        document.body.appendChild(p);
    }

    const img = r.media?.find(m => m.type === 'IMAGE');
    const audio = r.media?.find(m => m.type === 'AUDIO');
    const loc = r.location;
    const ai = r.ai_analysis;
    const v = r.verification;
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const locName = loc?.user_location_name || loc?.device_location_name || (loc ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}` : 'Unknown');
    const srcIcon = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'}[r.source] || 'fa-mobile-screen-button';
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';
    const hoverAiSummary = ai?.ai_summary || '';
    const hoverUserText = r.description || ai?.transcription || '';
    const hoverDisplayText = hoverAiSummary || hoverUserText;

    const thumbUrl = img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) : '';
    const fullUrl  = img?.url && img.assembly_status === 'complete' ? getMediaUrl(img.url) : '';
    const audioUrl = audio?.url ? getMediaUrl(audio.url) : (audio?.thumbnail_url ? getMediaUrl(audio.thumbnail_url) : '');
    // Phase 2.2: if the best variant isn't ready yet but the backend has
    // written a partial JPEG (0 < completion_pct < 100), surface it here so
    // the hover-preview shows something recognisable within seconds of the
    // first chunk landing. Cache-busted by the same `?p=<pct>` stepping
    // that `bestVariant` uses.
    let partialPreviewUrl = '';
    if (img && img.type === 'IMAGE' && img.id &&
        img.assembly_status !== 'complete' &&
        (img.completion_pct || 0) > 0 && (img.completion_pct || 0) < 100) {
        partialPreviewUrl = getMediaUrl('static/' + img.id + '_partial.jpg')
                          + '?p=' + Math.floor(img.completion_pct);
    }
    // Phase 1.5: last-resort — blurhash placeholder. Used when no variant,
    // no partial thumbnail, and no partial file exists yet (e.g. meta POST
    // landed but the first chunk is still in flight). Never overrides a
    // real photo source.
    const blurPreviewUrl = blurhashToDataURL(r.blurhash);
    const photoSrc = fullUrl || thumbUrl || partialPreviewUrl || blurPreviewUrl || '';
    const satSrc = v?.satellite_image_url ? `${BACKEND_HOST}${v.satellite_image_url}` : '';

    // Verification score dots
    const scores = v?.scores || {};
    const dotCol = (val) => (val || 0) >= 20 ? '#22c55e' : (val || 0) >= 13 ? '#eab308' : '#ef4444';
    const gc = v ? (v.total_score >= 60 ? '#22c55e' : v.total_score >= 40 ? '#eab308' : '#ef4444') : '';

    p.innerHTML = `
        <div class="fp-header">
            <span class="fp-sev-strip" style="background:${sevColor};"></span>
            <div class="fp-header-info">
                <div class="fp-title-row">
                    <i class="fa-solid ${INFRA_ICONS[r.infrastructure_type] || 'fa-triangle-exclamation'}" style="color:${sevColor};"></i>
                    <span class="fp-type">${r.infrastructure_type.replace(/_/g,' ')}</span>
                    <span class="fp-sev-badge" style="background:${sevColor}20;color:${sevColor};">${r.severity}</span>
                    <span class="fp-status-badge fp-st-${r.status}">${r.status === 'RESPONDING' || r.status === 'RESOLVED' ? 'HELPED' : r.status === 'FALSE_ALARM' ? 'FALSE' : r.status}</span>
                </div>
                <div class="fp-meta-row">
                    <span>${timeAgo(r.server_created_at)}</span>
                    <span><i class="${srcBrand} ${srcIcon}"></i> ${r.source}</span>
                    ${v ? `<span style="color:${gc};font-weight:700;">${v.total_score}/100</span>` : '<span style="color:var(--text-dim);">Not verified</span>'}
                </div>
            </div>
        </div>
        ${photoSrc ? `<div class="fp-img-section">
            <img id="fp-preview-img" src="${photoSrc}" class="fp-photo" onerror="this.style.display='none'"${
                // Phase 1.5: when the only thing we have is the blurhash,
                // apply a soft blur + saturation bump so the image reads as
                // a placeholder (not a low-res real photo). The filter is
                // dropped automatically once a real variant replaces the src.
                photoSrc === blurPreviewUrl && photoSrc ? ' style="filter:blur(6px) saturate(1.1);"' : ''
            }>
            ${satSrc ? `<div class="fp-img-toggle">
                <button class="fp-itg active" onclick="event.stopPropagation();document.getElementById('fp-preview-img').src='${photoSrc}';this.classList.add('active');this.nextElementSibling.classList.remove('active')"><i class="fa-solid fa-camera"></i></button>
                <button class="fp-itg" onclick="event.stopPropagation();document.getElementById('fp-preview-img').src='${satSrc}';this.classList.add('active');this.previousElementSibling.classList.remove('active')"><i class="fa-solid fa-satellite"></i></button>
            </div>` : ''}
        </div>` : ''}
        <div class="fp-body">
            ${hoverAiSummary ? `<div class="fp-text" style="border-left:2px solid #3b82f6;padding-left:6px;"><i class="fa-solid fa-robot" style="font-size:10px;color:#3b82f6;margin-right:3px;"></i>${hoverAiSummary.substring(0, 140)}${hoverAiSummary.length > 140 ? '...' : ''}</div>` : ''}
            ${hoverUserText && (!hoverAiSummary || hoverUserText !== hoverAiSummary) ? `<div class="fp-text" style="font-size:11px;color:#94a3b8;margin-top:3px;"><i class="fa-solid fa-user" style="font-size:9px;margin-right:3px;"></i>${hoverUserText.substring(0, 100)}${hoverUserText.length > 100 ? '...' : ''}</div>` : ''}
            ${!hoverAiSummary && !hoverUserText ? '' : ''}
            <div class="fp-loc-row"><i class="fa-solid fa-location-dot" style="color:${sevColor};"></i> ${locName}</div>
            ${audioUrl ? `<button class="fp-play-btn" onclick="event.stopPropagation();playPreviewAudio('${audioUrl}',this)"><i class="fa-solid fa-play"></i> Play Audio</button>` : ''}
            ${v ? `<div class="fp-verify-row">
                <span class="fp-verify-score" style="color:${gc};">${v.total_score}</span>
                <div class="fp-verify-dots">
                    <span style="color:${dotCol(scores.location_authenticity)};">● Loc ${scores.location_authenticity ?? '—'}</span>
                    <span style="color:${dotCol(scores.damage_corroboration)};">● Dmg ${scores.damage_corroboration ?? '—'}</span>
                    <span style="color:${dotCol(scores.description_coherence)};">● Desc ${scores.description_coherence ?? '—'}</span>
                    <span style="color:${dotCol(scores.data_quality)};">● Data ${scores.data_quality ?? '—'}</span>
                </div>
            </div>` : ''}
        </div>
        <div class="fp-actions">
            ${r.status === 'PENDING' || r.status === 'VERIFIED' ? `<button class="fp-act fp-act-dispatch" onclick="event.stopPropagation();patchReport('${r.id}','dispatch');hideIncidentPreview()"><i class="fa-solid fa-hands-helping"></i> Send Help</button>` : ''}
            ${r.status !== 'FALSE_ALARM' ? `<button class="fp-act fp-act-false" onclick="event.stopPropagation();patchReport('${r.id}','false-alarm');hideIncidentPreview()"><i class="fa-solid fa-ban"></i> False</button>` : ''}
            <button class="fp-act fp-act-detail" onclick="event.stopPropagation();selectReport('${r.id}');hideIncidentPreview()"><i class="fa-solid fa-expand"></i></button>
        </div>
    `;

    // Position near cursor but within viewport
    const rect = event.target.getBoundingClientRect();
    const panelLeft = rect.right + 12;
    const maxLeft = window.innerWidth - 380;
    const maxTop = window.innerHeight - p.offsetHeight - 20;
    p.style.left = `${Math.min(panelLeft, maxLeft)}px`;
    p.style.top = `${Math.max(Math.min(rect.top - 20, maxTop), 10)}px`;
    p.style.display = 'flex';

    // Keep tooltip visible when hovering over it (for action buttons)
    p.onmouseenter = () => { p._hovered = true; };
    p.onmouseleave = () => { p._hovered = false; hideIncidentPreview(); };
}

let _hidePreviewTimer = null;
function hideIncidentPreview() {
    clearTimeout(_hidePreviewTimer);
    _hidePreviewTimer = setTimeout(() => {
        const p = document.getElementById('fast-preview');
        if (p && !p._hovered) p.style.display = 'none';
    }, 150);
}

window.playPreviewAudio = function (url, btn) {
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        if (currentAudio._btn) currentAudio._btn.innerHTML = '<i class="fa-solid fa-play"></i> Play Audio';
        if (currentAudio._url === url) { currentAudio = null; return; }
    }
    currentAudio = new Audio(url);
    currentAudio._btn = btn;
    currentAudio._url = url;
    btn.innerHTML = '<i class="fa-solid fa-pause"></i> Playing...';
    currentAudio.play();
    currentAudio.onended = () => { btn.innerHTML = '<i class="fa-solid fa-play"></i> Play Audio'; };
};

// ── Detail Panel ─────────────────────────────────────────────────────────────
// skipFly=true when called from poll loop — avoids jarring map movement on auto-refresh
window.selectReport = (id, skipFly = false) => {
    selectedId = id;
    const r = allReports.find(x => x.id === id);
    if (!r) return;

    const panel = document.getElementById('detail-panel');
    panel.style.display = 'flex';

    const allImages = r.media?.filter(m => m.type === 'IMAGE') || [];
    // Guaranteed-delivery: each captured photo may have up to 3 Media rows
    // (SMALL/MEDIUM/LARGE) linked by photo_group_id. Fold them into groups
    // so the gallery shows one thumb per photo, and pick the best-available
    // variant for each group.
    const photoGroups = groupPhotos(allImages);
    const img = allImages[0] || null;  // kept for existing downstream refs
    const audio = r.media?.find(m => m.type === 'AUDIO');
    const loc   = r.location;
    const ai    = r.ai_analysis;
    const v     = r.verification;
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const infraIcon = INFRA_ICONS[r.infrastructure_type] || 'fa-triangle-exclamation';
    const locName = loc?.user_location_name || loc?.device_location_name || null;
    const locLat  = loc?.latitude;
    const locLng  = loc?.longitude;

    // ── Urgency signals ──
    const nearbyCount = allReports.filter(rr => rr.id !== r.id && rr.location && loc &&
        haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) < 5).length;
    const isCriticalInfra = ['HOSPITAL','POWER','POWER_PLANT','WATER','WATER_TREATMENT'].includes(r.infrastructure_type);
    const waitMs = Date.now() - new Date(ensureUTC(r.server_created_at)).getTime();
    const waitMin = Math.round(waitMs / 60000);

    // ── Image HTML (compact 160px) ──
    // Guaranteed-delivery: pick the best complete variant of the FIRST
    // photo group (main photo). Falls back to partial thumbnail if nothing
    // complete yet. Progressive-upgrade on subsequent polls is handled by
    // `_maybeUpgradeDetailImage` below, which swaps the <img src> without
    // rebuilding the DOM.
    const primaryGroup = photoGroups[0] || null;
    // Phase 2: honour the user's manual tier pick (if any). Falls back to
    // `bestVariant()` which returns the highest-tier complete variant.
    let variantPick = primaryGroup ? bestVariant(primaryGroup) : null;
    const overrideTier = _tierOverride.get(r.id);
    if (primaryGroup && overrideTier) {
        const manual = primaryGroup.members.find(
            m => m.resolution_tier === overrideTier &&
                 m.assembly_status === 'complete' && m.url
        );
        if (manual) {
            variantPick = {
                src: getMediaUrl(manual.url),
                tier: manual.resolution_tier,
                isFinal: true,
                mediaId: manual.id,
            };
        }
        // If the chosen tier isn't complete yet, fall through to bestVariant.
    }
    // Show the overall progress of the group (max across any variant) so
    // users see upload motion even before the SMALL variant completes.
    const imgPct = primaryGroup
        ? Math.max(0, ...primaryGroup.members.map(m => m.completion_pct || 0))
        : 0;
    const imgComplete = variantPick?.isFinal === true;
    const imgSrc = variantPick?.src || '';
    // Phase 2: 3-button tier switcher. Replaces the old read-only chip.
    // Each button is disabled when that tier hasn't finished assembly yet;
    // hovering shows the completion-pct of the pending tier.
    const tierSwitcher = primaryGroup ? _buildTierSwitcher(r.id, primaryGroup, variantPick?.tier) : '';
    // Phase 1.5: if nothing else is renderable yet, try the report's
    // blurhash for instant first-visual. Decoding is cached; returns null
    // when the hash is missing (legacy report) or malformed — in which case
    // we fall back to the original "awaiting media" icon placeholder.
    const blurDataUrl = !imgSrc ? blurhashToDataURL(r.blurhash) : null;
    const imgHtml = primaryGroup ? (
        imgComplete
            ? `<div class="dp-img" data-group-id="${primaryGroup.group_id || ''}"
                   data-current-tier="${variantPick.tier}"
                   onclick="openLightbox('${imgSrc}','${r.infrastructure_type}')">
                   <img src="${imgSrc}" class="img-full-layer img-ready">
                   ${tierSwitcher}
               </div>`
            : imgSrc
                ? `<div class="dp-img dp-img-uploading" data-group-id="${primaryGroup.group_id || ''}">
                       <img src="${imgSrc}" class="img-thumb-bg">
                       <div class="img-progress-overlay">
                           <div class="chunk-progress-track"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div>
                           <span class="partial-img-label"><i class="fa-solid fa-cloud-arrow-up fa-pulse"></i> ${imgPct.toFixed(0)}%</span>
                       </div>
                       ${tierSwitcher}
                   </div>`
                : blurDataUrl
                    // Phase 1.5: blurhash placeholder — the <div> carries
                    // `data-group-id` so `_maybeUpgradeDetailImage` finds
                    // and hot-swaps this element once a real variant lands.
                    ? `<div class="dp-img dp-img-uploading" data-group-id="${primaryGroup.group_id || ''}">
                           <img src="${blurDataUrl}" class="img-thumb-bg" style="filter:blur(8px) saturate(1.1);">
                           <div class="img-progress-overlay">
                               <div class="chunk-progress-track"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div>
                               <span class="partial-img-label"><i class="fa-solid fa-cloud-arrow-up fa-pulse"></i> ${imgPct.toFixed(0)}%</span>
                           </div>
                           ${tierSwitcher}
                       </div>`
                    : imgPct > 0
                        ? `<div class="dp-img dp-img-placeholder"><div class="chunk-progress-track" style="width:80%"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div><span style="font-size:12px;color:#6b7280;">${imgPct.toFixed(0)}%</span></div>`
                        : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera" style="font-size:18px;color:#334155;"></i></div>`
    ) : (
        // No media rows at all (meta POST landed but upload hasn't started):
        // if the report carries a blurhash, use it as the placeholder instead
        // of the "camera-slash" icon — gives the analyst an immediate sense
        // of the scene while the uploader negotiates the first chunk.
        blurDataUrl
            ? `<div class="dp-img dp-img-placeholder" style="padding:0;overflow:hidden;">
                   <img src="${blurDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;filter:blur(8px) saturate(1.1);">
               </div>`
            : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera-slash" style="font-size:16px;color:#334155;"></i></div>`
    );

    // ── Satellite image HTML (with alt source toggle) ──
    const satSrc    = v?.satellite_image_url ? `${BACKEND_HOST}${v.satellite_image_url}` : '';
    const satAltSrc = v?.satellite_image_url_alt ? `${BACKEND_HOST}${v.satellite_image_url_alt}` : '';
    const satPrimaryLabel = (v?.satellite_source || 'Satellite').split('(')[0].trim();
    const satAltLabel     = (v?.satellite_source_alt || 'Alt').split('(')[0].trim();
    const satHtml = satSrc
        ? `<div class="dp-sat-wrap">
               ${satAltSrc ? `<div class="dp-sat-tabs">
                   <button class="dp-sat-tab active" onclick="switchSatSource('${r.id}','primary',this,'${satSrc}')">${satPrimaryLabel}</button>
                   <button class="dp-sat-tab" onclick="switchSatSource('${r.id}','alt',this,'${satAltSrc}')">${satAltLabel}</button>
               </div>` : ''}
               <div class="dp-img" onclick="openLightbox(document.getElementById('dp-sat-img-${r.id}').src,'Satellite')">
                   <img id="dp-sat-img-${r.id}" src="${satSrc}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">
               </div>
           </div>`
        : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-satellite" style="font-size:16px;color:#334155;"></i><span style="font-size:12px;color:#475569;">Not verified</span></div>`;

    // ── Audio HTML (compact inline strip) ──
    const aPct = (audio?.completion_pct ?? 0);
    const aComplete = audio?.assembly_status === 'complete' && audio?.url;
    const aPartialUrl = audio?.thumbnail_url ? getMediaUrl(audio.thumbnail_url) + '?_cb=' + (Math.round(aPct/5)*5) : '';
    const audioPlayUrl = aComplete ? getMediaUrl(audio.url) : aPartialUrl;

    // ── Image match score (shown below image section) ──
    const imgMatchHtml = v ? (() => {
        const total = v.total_score || 0;
        const gc = total >= 80 ? '#22c55e' : total >= 60 ? '#86efac' : total >= 40 ? '#eab308' : total >= 20 ? '#f97316' : '#ef4444';
        const damageScore = v.scores?.damage_corroboration || 0;
        const matchPct = Math.round((damageScore / 25) * 100);
        return `<div class="dp-img-match"><i class="fa-solid fa-brain" style="color:${gc};"></i> Image Match Score: <strong style="color:${gc};">${matchPct}%</strong> <span style="color:var(--text-dim);">· Overall: ${total}/100</span></div>`;
    })() : '';

    // ── Satellite verification: score + 1-paragraph summary ──
    const vGaugeHtml = (() => {
        if (!v) return '';
        const total = v.total_score || 0;
        const gc = total >= 80 ? '#22c55e' : total >= 60 ? '#86efac' : total >= 40 ? '#eab308' : total >= 20 ? '#f97316' : '#ef4444';
        const verdictLabels = { STRONGLY_CORROBORATED:'Corroborated', LIKELY_AUTHENTIC:'Likely Authentic', PARTIALLY_VERIFIED:'Partial', LOW_CONFIDENCE:'Low Confidence', UNVERIFIED:'Unverified' };
        const vLabel = verdictLabels[v.verdict] || v.verdict || '';
        // Build 1-paragraph summary from available data
        const parts = [];
        if (v.photo_analysis) parts.push(v.photo_analysis);
        else if (v.satellite_scene_description) parts.push(v.satellite_scene_description);
        if (v.key_findings?.length) parts.push(v.key_findings[0]);
        if (v.caveats?.length) parts.push('Caveat: ' + v.caveats[0]);
        const paragraph = parts.join(' ').substring(0, 250) || 'Satellite comparison completed.';

        return `
        <div class="dp-sat-result">
            <div class="dp-sat-header-row">
                <i class="fa-solid fa-satellite" style="color:${gc};font-size:12px;"></i>
                <span style="font-size:13px;font-weight:800;color:${gc};">${total}/100</span>
                <span style="font-size:11px;font-weight:700;color:${gc};text-transform:uppercase;">${vLabel}</span>
                <div class="dp-sat-bar"><div class="dp-sat-bar-fill" style="width:${total}%;background:${gc};"></div></div>
            </div>
            <p class="dp-sat-para">${paragraph}${parts.join(' ').length > 250 ? '…' : ''}</p>
        </div>`;
    })();

    // ── Build decision-first detail panel ──
    // Header: type + severity + status + confidence + time
    document.getElementById('detail-title').innerHTML = `
        <i class="fa-solid ${infraIcon}" style="color:${sevColor};"></i>
        ${r.infrastructure_type.replace(/_/g,' ')}
        <span class="detail-sev-badge detail-sev-${r.severity}">${r.severity}</span>
        <span class="status-badge status-${r.status}">${r.status}</span>
        <span class="dp-source-badge dp-src-${(r.source || 'APP').toLowerCase()}" title="Reported via ${{APP:'Mobile App',ANDROID:'Android App',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[r.source] || 'Mobile App'}">${{APP:'<i class="fa-solid fa-mobile-screen-button"></i> App',ANDROID:'<i class="fa-solid fa-robot"></i> Android',WHATSAPP:'<i class="fa-brands fa-whatsapp"></i> WhatsApp',TELEGRAM:'<i class="fa-brands fa-telegram"></i> Telegram',SMS:'<i class="fa-solid fa-comment-sms"></i> SMS',IVR:'<i class="fa-solid fa-phone"></i> Call'}[r.source] || '<i class="fa-solid fa-mobile-screen-button"></i> App'}</span>
        <span class="dp-time-badge">${timeAgo(r.server_created_at)}</span>
    `;

    // Urgency alerts
    const urgencyHtml = (() => {
        const alerts = [];
        if (r.severity === 'CRITICAL') alerts.push('<span class="dp-urgency dp-urgency-red"><i class="fa-solid fa-circle-exclamation"></i> CRITICAL SEVERITY</span>');
        if (isCriticalInfra) alerts.push(`<span class="dp-urgency dp-urgency-red"><i class="fa-solid fa-building-shield"></i> Critical Infrastructure</span>`);
        if (nearbyCount > 0) alerts.push(`<span class="dp-urgency dp-urgency-amber"><i class="fa-solid fa-layer-group"></i> ${nearbyCount} more report${nearbyCount > 1 ? 's' : ''} nearby</span>`);
        if (waitMin > 30 && (r.status === 'PENDING' || r.status === 'VERIFIED')) alerts.push(`<span class="dp-urgency dp-urgency-red"><i class="fa-solid fa-clock"></i> Waiting ${waitMin > 60 ? Math.floor(waitMin/60) + 'h ' + (waitMin%60) + 'm' : waitMin + 'm'}</span>`);
        return alerts.length ? `<div class="dp-urgency-bar">${alerts.join('')}</div>` : '';
    })();

    // Transcript with keyword highlighting
    const highlightKeywords = (text, truncate = true) => {
        if (!text) return '';
        // Escape HTML first to prevent XSS, then apply keyword highlighting
        let safe = escapeHtml(truncate && text.length > 150 ? text.substring(0, 150) : text);
        const keywords = ['help','stuck','trapped','injury','injured','flood','fire','collapse','damage','emergency','rescue','save','water','destroy'];
        keywords.forEach(k => {
            const re = new RegExp(`(${k})`, 'gi');
            safe = safe.replace(re, '<mark class="dp-keyword">$1</mark>');
        });
        return safe + (text.length > 150 ? '...' : '');
    };

    const rawTranscript = ai?.transcription || '';
    const aiSummary = ai?.ai_summary || '';
    const userDescription = r.description || '';
    // For display: AI summary takes priority, fallback to description, then raw transcript
    const primaryText = aiSummary || userDescription || rawTranscript;
    // Show raw transcript if it differs from AI summary (so admin sees both)
    const showRawTranscript = rawTranscript && rawTranscript !== aiSummary && rawTranscript !== userDescription;

    // Build audio players for ALL audio media (location + description recordings)
    const allAudioMedia = r.media?.filter(m => m.type === 'AUDIO') || [];

    // ── Conditional evidence visibility ──
    const hasVisualEvidence = img || (v && satSrc);
    const isVoiceOrText = ['IVR','SMS'].includes(r.source);

    // Quick summary text for top bar (for data-rich sources only)
    const displayText = userDescription || rawTranscript || aiSummary || '';
    // Use DB-persisted ai_assessment (survives refresh) or client-cached _aiAssessment
    const cachedAA = r.ai_assessment || r._aiAssessment || null;
    const aaScore = cachedAA?.confidence_score ?? cachedAA?.score ?? null;
    const aaAction = cachedAA?.suggested_action ?? cachedAA?.action ?? '';
    const aaSummary = cachedAA?.summary ?? '';
    const aaDetails = cachedAA?.details ?? '';

    document.getElementById('detail-body').innerHTML = `
        <!-- ① TOP: Credibility Check result OR "Credibility Check" button -->
        <div class="dp-action-bar">
            <div class="dp-top-row">
                <div class="dp-quick-summary">
                    ${cachedAA ? (() => {
                        const ac = aaAction.includes('Dispatch') ? '#22c55e' : aaAction.includes('False') ? '#ef4444' : aaAction.includes('Suspicious') ? '#f97316' : '#eab308';
                        const cc = aaScore >= 70 ? '#22c55e' : aaScore >= 50 ? '#eab308' : aaScore >= 30 ? '#f97316' : '#ef4444';
                        const priority = cachedAA.priority_level || '';
                        const pColor = priority.includes('P1') ? '#ef4444' : priority.includes('P2') ? '#f97316' : priority.includes('P3') ? '#eab308' : priority.includes('P4') ? '#3b82f6' : '#64748b';
                        const lives = cachedAA.lives_at_risk_estimate || '';
                        const keyFactors = cachedAA.key_factors || [];
                        const riskFlags = cachedAA.risk_flags || [];
                        return `<div class="dp-top-ai">
                            <div class="dp-top-ai-row">
                                ${priority ? `<span class="dp-priority-badge" style="background:${pColor};">${priority.replace('_',' ')}</span>` : ''}
                                <span class="dp-top-ai-score" style="color:${cc};">${aaScore}<small>/100</small></span>
                                <span class="dp-top-ai-action" style="color:${ac};">${aaAction}</span>
                                <button class="dp-ai-info-btn" onclick="event.stopPropagation();showAILogic('${r.id}')" title="View credibility reasoning"><i class="fa-solid fa-circle-info"></i></button>
                            </div>
                            ${lives ? `<div class="dp-lives-risk"><i class="fa-solid fa-people-group"></i> <strong>${lives}</strong> lives at risk</div>` : ''}
                            <p class="dp-summary-text">${aaSummary}</p>
                            ${keyFactors.length ? `<div class="dp-key-factors">${keyFactors.slice(0,3).map(f => `<span class="dp-factor-chip"><i class="fa-solid fa-check-circle"></i> ${escapeHtml(f)}</span>`).join('')}</div>` : ''}
                            ${riskFlags.length ? `<div class="dp-risk-flags">${riskFlags.map(f => `<span class="dp-flag-chip"><i class="fa-solid fa-exclamation-triangle"></i> ${escapeHtml(f)}</span>`).join('')}</div>` : ''}
                        </div>`;
                    })() : `<button class="dp-run-ai-btn" onclick="runAIAssessment('${r.id}')"><i class="fa-solid fa-shield-halved"></i> Credibility Check</button>`}
                </div>
                <button class="dp-pdf-btn" onclick="exportPDF('${r.id}')" title="Export PDF"><i class="fa-solid fa-file-pdf"></i></button>
            </div>
            <!-- Phase 5 (Apr 2026) — Reviewer actions + response-time strip.
                 Lives above the existing dispatch/resolve/false-alarm row so
                 analysts see the verdict + response-time context before
                 deciding to send help. -->
            ${_renderReviewerActions(r)}
            <div class="dp-action-buttons">
                ${r.status === 'PENDING' || r.status === 'VERIFIED'
                    ? `<button class="dp-act-main dp-act-dispatch" onclick="patchReport('${r.id}','dispatch')"><i class="fa-solid fa-hands-helping"></i> Send Help</button>`
                    : `<span class="dp-act-status"><i class="fa-solid fa-circle-check"></i> Help Sent</span>`}
                ${r.status !== 'FALSE_ALARM'
                    ? `<button class="dp-act-main dp-act-false" onclick="patchReport('${r.id}','false-alarm')"><i class="fa-solid fa-ban"></i> False</button>` : ''}
                <button class="dp-act-main dp-act-del" onclick="if(confirm('Delete this report?'))deleteReport('${r.id}')"><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>

        <!-- ② Urgency alerts -->
        ${urgencyHtml}

        <!-- ②b UNDP fields -->
        ${r.crisis_type || r.damage_classification || r.infrastructure_name || r.building_id || r.service_status ? `
        <div class="dp-undp-fields" style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">
            ${r.crisis_type ? `<span class="dp-field-badge" style="background:rgba(124,58,237,0.15);color:#a78bfa;"><i class="fa-solid fa-cloud-bolt"></i> ${r.crisis_type.replace(/_/g,' ')}</span>` : ''}
            ${r.damage_classification ? `<span class="dp-field-badge" style="background:${r.damage_classification==='COMPLETE'?'rgba(239,68,68,0.15);color:#f87171':r.damage_classification==='PARTIAL'?'rgba(249,115,22,0.15);color:#fb923c':'rgba(34,197,94,0.15);color:#4ade80'};"><i class="fa-solid fa-building-circle-xmark"></i> ${r.damage_classification.replace(/_/g,' ')}</span>` : ''}
            ${r.infrastructure_name ? `<span class="dp-field-badge" style="background:rgba(59,130,246,0.15);color:#93c5fd;"><i class="fa-solid fa-building"></i> ${escapeHtml(r.infrastructure_name)}</span>` : ''}
            ${r.debris_clearing_needed ? `<span class="dp-field-badge" style="background:rgba(245,158,11,0.15);color:#fbbf24;"><i class="fa-solid fa-truck-pickup"></i> Debris clearing</span>` : ''}
            ${r.building_id ? `<span class="dp-field-badge dp-building-link" style="background:rgba(99,102,241,0.15);color:#a5b4fc;cursor:pointer;" onclick="filterByBuilding('${r.building_id}')"><i class="fa-solid fa-timeline"></i> Building history</span>` : ''}
            <!-- Phase 1 reporter badge: masked "User abc12345" derived server-side
                 in ReportResponse._compute_identity_badge. Anonymous rows skip
                 this span entirely. ADMIN clicks open the profile drawer. -->
            ${r.reporter_badge ? `<span class="dp-field-badge dp-reporter-badge" style="background:rgba(34,197,94,0.12);color:#86efac;cursor:${r.user_id ? 'pointer' : 'default'};" ${r.user_id ? `onclick="openReporterProfile('${r.user_id}')"` : ''} title="${r.user_id ? 'Click to view reporter details (admin only)' : ''}"><i class="fa-solid fa-user-check"></i> ${escapeHtml(r.reporter_badge)}</span>` : ''}
            <!-- Phase E (Apr 2026 UI v3) — "Needs mapping" badge.
                 Fires when the reporter typed a building name in their
                 native language (PWA free-text fallback, RN TextInput,
                 Telegram STEP_BUILDING_NAME) without an OSM footprint
                 resolving the row. Operators click the row to open detail,
                 use the existing building-footprint picker on the dashboard
                 to resolve it to an osm:way:<id>, and the badge drops.
                 Derived server-side (see ReportResponse._compute_needs_manual_mapping)
                 so every response surface stays consistent. -->
            ${r.needs_manual_mapping === true ? `<span class="dp-field-badge dp-needs-mapping" style="background:rgba(239,68,68,0.16);color:#fca5a5;" title="The reporter typed the building name in their native language; resolve it to an OSM footprint."><i class="fa-solid fa-map-location-dot"></i> Needs mapping</span>` : ''}
            <!-- W4 versioning ribbon (Apr 2026 UI v2.1). Static placeholder that's
                 filled by dp-version-ribbon-${id} once ensureBuildingVersionIndex
                 resolves. UNDP Appendix asks the system to bias display to the
                 latest complete report for a given building; this ribbon makes
                 the version ordinal + latest/older state visible on the detail
                 panel. Green = latest, amber = older. Only rendered for reports
                 with a building_id. -->
            ${r.building_id ? `<span id="dp-version-ribbon-${r.id}" class="dp-field-badge dp-version-ribbon" style="background:rgba(148,163,184,0.12);color:#cbd5e1;"><i class="fa-solid fa-code-branch"></i> V …</span>` : ''}
        </div>
        ${r.service_status ? (() => {
            const ss = r.service_status;
            const svcColor = v => v === 'OPERATIONAL' ? '#4ade80' : v === 'DISRUPTED' ? '#fbbf24' : v === 'DESTROYED' ? '#f87171' : '#64748b';
            const svcIcon = v => v === 'OPERATIONAL' ? 'fa-circle-check' : v === 'DISRUPTED' ? 'fa-triangle-exclamation' : v === 'DESTROYED' ? 'fa-circle-xmark' : 'fa-circle-question';
            let html = '<div class="dp-svc-status" style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px;">';
            if (ss.electricity && ss.electricity !== 'UNKNOWN') html += `<span class="dp-field-badge" style="background:rgba(255,255,255,0.04);color:${svcColor(ss.electricity)};"><i class="fa-solid ${svcIcon(ss.electricity)}"></i> ⚡ ${ss.electricity}</span>`;
            if (ss.water && ss.water !== 'UNKNOWN') html += `<span class="dp-field-badge" style="background:rgba(255,255,255,0.04);color:${svcColor(ss.water)};"><i class="fa-solid ${svcIcon(ss.water)}"></i> 💧 ${ss.water}</span>`;
            if (ss.health && ss.health !== 'UNKNOWN') html += `<span class="dp-field-badge" style="background:rgba(255,255,255,0.04);color:${svcColor(ss.health)};"><i class="fa-solid ${svcIcon(ss.health)}"></i> 🏥 ${ss.health}</span>`;
            if (ss.pressing_needs?.length) html += `<span class="dp-field-badge" style="background:rgba(239,68,68,0.1);color:#fca5a5;"><i class="fa-solid fa-exclamation-circle"></i> Needs: ${ss.pressing_needs.join(', ')}</span>`;
            html += '</div>';
            return html;
        })() : ''}
        ` : ''}

        <!-- ③ Evidence: Images gallery + Satellite Verify -->
        ${hasVisualEvidence ? `
        <div class="dp-evidence-card">
            <div class="dp-img-view" id="dp-img-view-${r.id}" style="position:relative;">
                ${imgHtml}
                <div class="dp-pii-badge"><i class="fa-solid fa-shield-halved"></i> PII Protected</div>
            </div>
            ${photoGroups.length > 1 ? `
            <div class="dp-gallery">
                <div class="dp-gallery-label"><i class="fa-solid fa-images"></i> ${photoGroups.length} Photos</div>
                <div class="dp-gallery-strip">
                    ${photoGroups.map((g, idx) => {
                        // Guaranteed-delivery: pick the best complete variant
                        // per group so the thumb shows the highest-quality
                        // version available right now.
                        const pick = bestVariant(g);
                        if (!pick) return '';
                        // Progress bar shows the best completion_pct across
                        // the group so users see "60% uploading" for a
                        // partial upload.
                        const maxPct = Math.max(0, ...g.members.map(m => m.completion_pct || 0));
                        return `<div class="dp-gallery-thumb ${idx === 0 ? 'active' : ''}"
                                     data-group-id="${g.group_id || ''}"
                                     data-current-tier="${pick.tier}"
                                     onclick="dpShowGalleryImage('${r.id}',${idx},this)">
                            <img src="${pick.src}" alt="Photo ${idx+1}">
                            ${!pick.isFinal ? `<span class="dp-gallery-pct">${maxPct.toFixed(0)}%</span>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>` : ''}
            ${v && satSrc ? `<div class="dp-view-toggle">
                <button class="dp-vt-btn active" onclick="dpSwitchView('${r.id}','photo',this)"><i class="fa-solid fa-camera"></i> Photo</button>
                <button class="dp-vt-btn" onclick="dpSwitchView('${r.id}','sat',this)"><i class="fa-solid fa-satellite"></i> Satellite</button>
                ${satAltSrc ? `<button class="dp-vt-btn" onclick="dpSwitchView('${r.id}','alt',this)"><i class="fa-solid fa-globe"></i> ${satAltLabel}</button>` : ''}
                <button class="dp-vt-btn dp-vt-compare" onclick="dpSwitchView('${r.id}','compare',this)"><i class="fa-solid fa-columns"></i> Compare</button>
            </div>` : ''}
            ${v ? vGaugeHtml : `<button class="dp-sat-verify-btn" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')">
                <i class="fa-solid fa-satellite"></i> Verify via Satellite
            </button>`}
        </div>` : `
        <div class="dp-no-image-verify">
            <button class="dp-sat-verify-btn" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')">
                <i class="fa-solid fa-satellite"></i> ${v ? 'Re-verify Satellite' : 'Verify via Satellite'}
            </button>
            ${v ? vGaugeHtml : ''}
        </div>`}

        <!-- ④ Audio + User Transcription -->
        ${displayText || allAudioMedia.length ? `
        <div class="dp-transcript-card">
            ${allAudioMedia.length > 0 ? allAudioMedia.map((am, idx) => {
                const amComplete = am.assembly_status === 'complete' && am.url;
                const amPct = am.completion_pct ?? (amComplete ? 100 : 0);
                const amPartialUrl = am.thumbnail_url ? getMediaUrl(am.thumbnail_url) + '?_cb=' + (Math.round(amPct/5)*5) : '';
                const amPlayUrl = amComplete ? getMediaUrl(am.url) : amPartialUrl;
                const label = allAudioMedia.length > 1 ? (idx === 0 ? 'Location' : 'Description') : 'Audio';
                return `<div class="dp-audio-row">
                    <button class="dp-audio-btn ${amComplete ? '' : 'uploading'}" onclick="playDetailAudio(this, '${amPlayUrl || ''}')">
                        <i class="fa-solid ${amComplete ? 'fa-play' : amPartialUrl ? 'fa-cloud-arrow-up fa-pulse' : 'fa-microphone'}"></i>
                    </button>
                    <span class="dp-audio-label">${label}</span>
                    <div class="dp-audio-bar-wrap">
                        <div class="audio-progress-bar" style="height:3px;"><div class="audio-progress-fill" id="detail-audio-fill-${idx}"></div></div>
                        <div class="audio-time" style="font-size:11px;"><span id="detail-audio-cur-${idx}">0:00</span><span id="detail-audio-dur-${idx}">${amComplete ? '0:00' : '--:--'}</span></div>
                    </div>
                    ${!amComplete && amPct > 0 ? `<span class="dp-upload-pct">${amPct.toFixed(0)}%</span>` : ''}
                </div>`;
            }).join('') : ''}

            ${displayText ? `
                <div class="dp-text-section">
                    <div class="dp-text-label"><i class="fa-solid fa-align-left"></i> ${isVoiceOrText ? 'User Report' : 'Description'}</div>
                    <div class="dp-transcript-text" id="dp-transcript-short">${highlightKeywords(displayText, true)}${displayText.length > 150 ? `<span class="dp-text-expand" onclick="document.getElementById('dp-transcript-short').style.display='none';document.getElementById('dp-transcript-full').style.display='block';">… read more</span>` : ''}</div>
                    ${displayText.length > 150 ? `<div class="dp-transcript-text dp-transcript-full" id="dp-transcript-full" style="display:none;">${highlightKeywords(displayText, false)}<span class="dp-text-expand" onclick="document.getElementById('dp-transcript-full').style.display='none';document.getElementById('dp-transcript-short').style.display='block';"> show less</span></div>` : ''}
                </div>
            ` : ''}
        </div>` : ''}

        <!-- ⑤ Location + Caller Info -->
        ${loc || r.caller_info ? (() => {
            const mismatch = loc?.is_user_corrected && loc?.device_latitude && loc?.device_longitude;
            const distKm = mismatch ? Math.round(haversineKm(loc.latitude, loc.longitude, loc.device_latitude, loc.device_longitude)) : 0;
            const userName = loc ? (loc.user_location_name || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`) : '';
            const devName  = mismatch ? (loc.device_location_name || `${loc.device_latitude?.toFixed(4)}, ${loc.device_longitude?.toFixed(4)}`) : '';
            const ci = r.caller_info || {};
            const phone = ci.phone || '';
            const netLoc = ci.network_location || [ci.network_city, ci.network_state, ci.network_country].filter(Boolean).join(', ');
            const hasCallerInfo = phone || netLoc;
            return `<div class="dp-loc-card ${mismatch ? 'dp-loc-mismatch' : ''}">
                <div class="dp-section-label"><i class="fa-solid fa-location-dot"></i> Location${hasCallerInfo ? ' & Contact' : ''}</div>
                ${loc ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-map-pin" style="color:${sevColor};"></i>
                    <span class="dp-loc-name">${userName}</span>
                    <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${loc.latitude}, ${loc.longitude}'); showToast('Coords copied','success')"><i class="fa-solid fa-copy"></i></button>
                </div>` : ''}
                ${mismatch ? `<div class="dp-loc-row dp-loc-device">
                    <i class="fa-solid fa-mobile-screen" style="color:#94a3b8;"></i>
                    <span class="dp-loc-name" style="color:var(--text-sub);">${devName}</span>
                    <span class="dp-loc-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${distKm}km mismatch</span>
                </div>` : ''}
                ${hasCallerInfo ? `<div class="dp-loc-divider"></div>` : ''}
                ${phone ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-phone" style="color:#a855f7;"></i>
                    <a href="tel:${phone}" class="dp-caller-phone">${phone}</a>
                    <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${phone}'); showToast('Phone copied','success')"><i class="fa-solid fa-copy"></i></button>
                </div>` : ''}
                ${netLoc ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-tower-cell" style="color:#94a3b8;"></i>
                    <span class="dp-caller-net">Telecom: ${netLoc}</span>
                </div>` : ''}
            </div>`;
        })() : ''}

        <!-- ⑥ Source Details (collapsible) -->
        <div class="dp-source-details">
            <button class="dp-expand-btn" onclick="const el=document.getElementById('dp-source-body');const ic=this.querySelector('i');if(el.style.display==='none'){el.style.display='block';ic.classList.replace('fa-chevron-down','fa-chevron-up');}else{el.style.display='none';ic.classList.replace('fa-chevron-up','fa-chevron-down');}">
                <i class="fa-solid fa-chevron-down"></i> <span style="color:${{APP:'#7c3aed',WHATSAPP:'#25d366',TELEGRAM:'#26a5e4',SMS:'#f59e0b',IVR:'#ec4899'}[r.source] || '#94a3b8'};">Source Details — ${{APP:'Mobile App',ANDROID:'Android App',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[r.source] || r.source}</span>
            </button>
            <div id="dp-source-body" style="display:none;" class="dp-source-detail-body">
                <div class="dp-meta-row"><span class="dp-meta-key">Channel</span><span>${{APP:'Progressive Web App',WHATSAPP:'WhatsApp Bot',TELEGRAM:'Telegram Bot',SMS:'SMS Gateway',IVR:'IVR Voice Call'}[r.source] || r.source}</span></div>
                <div class="dp-meta-row"><span class="dp-meta-key">Report ID</span><span style="font-family:monospace;font-size:11px;">${r.id.substring(0,12)}…</span></div>
                <div class="dp-meta-row"><span class="dp-meta-key">Media</span><span>${r.received_media}/${r.expected_media} received</span></div>
                <div class="dp-meta-row"><span class="dp-meta-key">Submitted</span><span>${new Date(ensureUTC(r.server_created_at)).toLocaleString()}</span></div>
                ${r.is_auto_submitted ? `<div class="dp-meta-row"><span class="dp-meta-key">Auto</span><span style="color:#f59e0b;">Auto-submitted</span></div>` : ''}
            </div>
        </div>
    `;

    // ── Action dock hidden — actions now in top bar ──
    document.getElementById('dp-action-dock').innerHTML = '';

    // W4 versioning ribbon fill (Apr 2026 UI v2.1). Async because we
    // may need to hit /reports/building/{id} the first time. Guarded
    // against the panel having been closed or switched mid-fetch
    // (document.getElementById returns null if the ribbon element was
    // replaced by a subsequent selectReport). Green = latest, amber =
    // older. If the building has only one report, the ribbon collapses
    // to "Only report" instead of "V 1 of 1" which is confusing.
    (async () => {
        if (!r.building_id) return;
        const el = document.getElementById(`dp-version-ribbon-${r.id}`);
        if (!el) return;
        const idx = await (window.ensureBuildingVersionIndex
            ? window.ensureBuildingVersionIndex(r)
            : null);
        if (!idx) {
            el.style.display = 'none';   // hide the placeholder on fetch failure
            return;
        }
        if (idx.total <= 1) {
            el.innerHTML = `<i class="fa-solid fa-code-branch"></i> Only report`;
            el.style.background = 'rgba(148,163,184,0.12)';
            el.style.color      = '#cbd5e1';
            return;
        }
        if (idx.is_latest) {
            el.innerHTML = `<i class="fa-solid fa-code-branch"></i> V ${idx.ordinal} of ${idx.total} · Latest`;
            el.style.background = 'rgba(34,197,94,0.15)';
            el.style.color      = '#4ade80';
        } else {
            el.innerHTML = `<i class="fa-solid fa-code-branch"></i> V ${idx.ordinal} of ${idx.total} · Older`;
            el.style.background = 'rgba(245,158,11,0.15)';
            el.style.color      = '#fbbf24';
        }
        el.style.cursor = 'pointer';
        el.onclick = () => window.filterByBuilding(r.building_id);
        el.title = `Click to highlight all ${idx.total} reports for this building on the map`;
    })();

    if (loc && !skipFly) map.flyTo([loc.latitude, loc.longitude], 15);
    renderFeed();
};

// Image/Satellite view toggle in detail panel
window.dpSwitchView = (reportId, view, btn) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const container = document.getElementById(`dp-img-view-${reportId}`);
    if (!container) return;
    const img = r.media?.find(m => m.type === 'IMAGE');
    const v = r.verification;
    btn.parentElement.querySelectorAll('.dp-vt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (view === 'compare') {
        // Open full-screen compare overlay
        dpOpenCompare(r);
        return;
    }
    // Reset to single view aspect ratio
    container.closest('.dp-evidence-card').querySelector('.dp-img-view .dp-img')?.style?.removeProperty?.('aspect-ratio');
    if (view === 'photo' && img?.url) {
        container.innerHTML = `<div class="dp-img" onclick="openLightbox('${getMediaUrl(img.url)}','Photo')"><img src="${getMediaUrl(img.url)}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>`;
    } else if (view === 'sat' && v?.satellite_image_url) {
        container.innerHTML = `<div class="dp-img" onclick="openLightbox('${BACKEND_HOST}${v.satellite_image_url}','Satellite')"><img src="${BACKEND_HOST}${v.satellite_image_url}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>`;
    } else if (view === 'alt' && v?.satellite_image_url_alt) {
        container.innerHTML = `<div class="dp-img" onclick="openLightbox('${BACKEND_HOST}${v.satellite_image_url_alt}','Alt Satellite')"><img src="${BACKEND_HOST}${v.satellite_image_url_alt}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>`;
    }
};

// Gallery image switcher — click thumbnail to show in main view.
// groupIdx is the index into the photo-group list (one group per captured
// photo, regardless of how many Media variant rows it has on the server).
window.dpShowGalleryImage = (reportId, groupIdx, thumbEl) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const groups = groupPhotos(images);
    const grp = groups[groupIdx];
    if (!grp) return;
    const pick = bestVariant(grp);
    if (!pick || !pick.src) return;
    const container = document.getElementById(`dp-img-view-${reportId}`);
    if (!container) return;
    const tierLabel = pick.tier === 'LOW' ? 'SMALL' : pick.tier === 'MEDIUM' ? 'MEDIUM' : pick.tier === 'HIGH' ? 'LARGE' : pick.tier;
    // Preserve the PII badge (and any other overlay children) — only swap the
    // <div class="dp-img"> block. The old innerHTML= wipe lost the shield chip
    // on every thumbnail click.
    const imgWrap = container.querySelector('.dp-img');
    const newImgHtml = `<div class="dp-img" data-group-id="${grp.groupId}" data-current-tier="${pick.tier}" onclick="openLightbox('${pick.src}','Photo ${groupIdx+1} of ${groups.length}')">
        <img src="${pick.src}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">
        <span class="dp-tier-chip dp-tier-${pick.tier.toLowerCase()}">${tierLabel}</span>
    </div>`;
    if (imgWrap) {
        imgWrap.outerHTML = newImgHtml;
    } else {
        container.insertAdjacentHTML('afterbegin', newImgHtml);
    }
    // Update active thumb
    thumbEl.parentElement.querySelectorAll('.dp-gallery-thumb').forEach(t => t.classList.remove('active'));
    thumbEl.classList.add('active');
};

// Full-screen multi-image compare overlay
window.dpOpenCompare = (r) => {
    const img = r.media?.find(m => m.type === 'IMAGE');
    const v = r.verification;
    const photoSrc = img?.url ? getMediaUrl(img.url) : '';
    const satSrc = v?.satellite_image_url ? `${BACKEND_HOST}${v.satellite_image_url}` : '';
    const altSrc = v?.satellite_image_url_alt ? `${BACKEND_HOST}${v.satellite_image_url_alt}` : '';
    const scores = v?.scores || {};
    const total = v?.total_score || 0;
    const damageMatch = scores.damage_corroboration ? Math.round((scores.damage_corroboration / 25) * 100) : 0;
    const locMatch = scores.location_authenticity ? Math.round((scores.location_authenticity / 25) * 100) : 0;
    const gc = (pct) => pct >= 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444';

    // Timestamps — satellite_acquisition_date is when the satellite CAPTURED the image (from provider API)
    const photoTime = r.server_created_at ? formatShortDate(r.server_created_at) : 'Unknown';
    const satAcqDate = v?.satellite_acquisition_date;
    const satTime = satAcqDate ? formatShortDate(satAcqDate) : 'Acq. date unavailable';
    const altAcqDate = v?.satellite_acquisition_date_alt;
    const altTime = altAcqDate ? formatShortDate(altAcqDate) : 'Acq. date unavailable';

    // Time gap between photo capture and satellite image capture
    const gapText = (acqDate) => {
        if (!acqDate || !r.server_created_at) return 'Date unknown — verify manually';
        const photoMs = new Date(ensureUTC(r.server_created_at)).getTime();
        const satMs = new Date(ensureUTC(acqDate)).getTime();
        const diffDays = Math.round((photoMs - satMs) / 86400000);
        if (diffDays === 0) return 'Same day as photo';
        if (diffDays > 0) return `Captured ${diffDays}d before incident`;
        return `Captured ${Math.abs(diffDays)}d after incident`;
    };

    // Build image panels with timestamps
    const panels = [];
    if (photoSrc) panels.push({ src: photoSrc, label: 'Reporter Photo', score: null, scoreLabel: 'Source', time: `Captured: ${photoTime}`, gap: '' });
    if (satSrc) panels.push({ src: satSrc, label: v?.satellite_source?.split('(')[0]?.trim() || 'Sentinel-2', score: damageMatch, scoreLabel: 'Damage Match', time: `Acquired: ${satTime}`, gap: gapText(satAcqDate) });
    if (altSrc) panels.push({ src: altSrc, label: v?.satellite_source_alt?.split('(')[0]?.trim() || 'Maxar', score: locMatch, scoreLabel: 'Location Match', time: `Acquired: ${altTime}`, gap: gapText(altAcqDate) });

    if (panels.length < 2) return;

    let overlay = document.getElementById('dp-compare-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dp-compare-overlay';
        overlay.className = 'dp-compare-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    overlay.innerHTML = `
        <div class="dp-compare-header">
            <div class="dp-compare-title"><i class="fa-solid fa-columns"></i> Image Comparison — ${r.infrastructure_type.replace(/_/g,' ')} · ${r.severity}</div>
            <div class="dp-compare-overall">Overall: <strong style="color:${gc(total)};">${total}/100</strong></div>
            <button class="dp-compare-close" onclick="document.getElementById('dp-compare-overlay').style.display='none'"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="dp-compare-grid" style="grid-template-columns:repeat(${panels.length},1fr);">
            ${panels.map(p => `
                <div class="dp-compare-panel">
                    <div class="dp-compare-label">${p.label}</div>
                    <div class="dp-compare-img-wrap">
                        <img src="${p.src}" class="dp-compare-img" onclick="this.classList.toggle('dp-zoomed')" title="Click to zoom">
                        ${p.score !== null ? `<div class="dp-compare-score" style="color:${gc(p.score)};">${p.scoreLabel}: ${p.score}%</div>` : ''}
                        <div class="dp-compare-time"><i class="fa-regular fa-clock"></i> ${p.time}${p.gap ? ` · ${p.gap}` : ''}</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
};


window.switchSatSource = (reportId, which, btn, src) => {
    const img = document.getElementById(`dp-sat-img-${reportId}`);
    if (img) img.src = src;
    btn.parentElement.querySelectorAll('.dp-sat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
};

window.closeDetail = () => {
    // Phase 2: clear tier override so the next time this report is opened
    // it defaults back to the best-complete variant.
    if (selectedId) _tierOverride.delete(selectedId);
    selectedId = null;
    document.getElementById('detail-panel').style.display = 'none';
    renderFeed();
};

// ── Phase 5 (Apr 2026) — Reviewer actions block ─────────────────────────────
// Renders a compact row showing the current verdict + two action buttons
// (Accept / Reject) + two timestamp buttons (Dispatched / Arrived).
// Response time displayed when both `reviewed_at` and a responder timestamp
// are set — value comes precomputed from the backend as `response_time_seconds`.

function _fmtDuration(secs) {
    if (!Number.isFinite(secs) || secs < 0) return '';
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
}

function _fmtReviewAgo(iso) {
    if (!iso) return '';
    const t = new Date(ensureUTC(iso)).getTime();
    if (!Number.isFinite(t)) return '';
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    return _fmtDuration(secs) + ' ago';
}

function _renderReviewerActions(r) {
    const verdict = (r.reviewer_verdict || 'NOT_REVIEWED');
    const verdictClass = verdict.toLowerCase();
    const verdictLabel = verdict === 'ACCEPTED' ? '✓ Accepted'
        : verdict === 'REJECTED' ? '✕ Rejected'
        : 'Not reviewed';
    const reviewedAgo = r.reviewed_at ? `Reviewed ${_fmtReviewAgo(r.reviewed_at)}` : '';
    const responseStr = Number.isFinite(r.response_time_seconds)
        ? `Response: ${_fmtDuration(r.response_time_seconds)}` : '';
    const dispatched = r.help_dispatched_at
        ? `Dispatched ${_fmtReviewAgo(r.help_dispatched_at)}` : '';
    const arrived = r.help_arrived_at
        ? `Arrived ${_fmtReviewAgo(r.help_arrived_at)}` : '';
    const actionTxt = (verdict === 'REJECTED' && r.action_taken)
        ? `<div class="dp-reviewer-note"><i class="fa-solid fa-comment-dots"></i> ${escapeHtml(r.action_taken)}</div>` : '';

    return `<div class="dp-reviewer">
        <div class="dp-reviewer-top">
            <span class="dp-reviewer-chip dp-reviewer-${verdictClass}">${verdictLabel}</span>
            ${reviewedAgo ? `<span class="dp-reviewer-meta">${reviewedAgo}</span>` : ''}
            ${responseStr ? `<span class="dp-reviewer-meta dp-reviewer-response">${responseStr}</span>` : ''}
        </div>
        ${dispatched || arrived ? `<div class="dp-reviewer-times">
            ${dispatched ? `<span><i class="fa-solid fa-truck-medical"></i> ${dispatched}</span>` : ''}
            ${arrived ? `<span><i class="fa-solid fa-map-pin"></i> ${arrived}</span>` : ''}
        </div>` : ''}
        ${actionTxt}
        <div class="dp-reviewer-btns">
            <button class="dp-reviewer-btn dp-reviewer-accept ${verdict === 'ACCEPTED' ? 'active' : ''}"
                    onclick="setReviewVerdict('${r.id}','ACCEPTED')" title="Mark accepted"><i class="fa-solid fa-check"></i> Accept</button>
            <button class="dp-reviewer-btn dp-reviewer-reject ${verdict === 'REJECTED' ? 'active' : ''}"
                    onclick="openRejectModal('${r.id}')" title="Mark rejected"><i class="fa-solid fa-xmark"></i> Reject</button>
            <button class="dp-reviewer-btn"
                    onclick="stampResponderTime('${r.id}','dispatched')"
                    ${r.help_dispatched_at ? 'disabled' : ''}><i class="fa-solid fa-truck-medical"></i> Dispatched</button>
            <button class="dp-reviewer-btn"
                    onclick="stampResponderTime('${r.id}','arrived')"
                    ${r.help_arrived_at ? 'disabled' : ''}><i class="fa-solid fa-map-pin"></i> Arrived</button>
        </div>
    </div>`;
}

window.setReviewVerdict = async (reportId, verdict, actionTaken = null) => {
    try {
        const body = { verdict };
        if (actionTaken) body.action_taken = actionTaken;
        const res = await fetch(`${API}/${reportId}/review`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Review failed: ${detail}`, 'error');
        }
        const updated = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        showToast(verdict === 'ACCEPTED' ? 'Marked accepted' : 'Marked rejected', 'success');
        if (selectedId === reportId) selectReport(reportId, true);
        renderFeed();
    } catch (e) {
        showToast(`Review error: ${e.message}`, 'error');
    }
};

window.openRejectModal = (reportId) => {
    const note = prompt(
        'Reject this report — please describe why (required).\n\n' +
        'This note is logged against the report so future responders see the rationale.',
        ''
    );
    if (note === null) return;   // user cancelled
    const trimmed = note.trim();
    if (!trimmed) {
        showToast('Rejection reason required', 'error');
        return;
    }
    window.setReviewVerdict(reportId, 'REJECTED', trimmed);
};

window.stampResponderTime = async (reportId, which) => {
    const body = which === 'arrived'
        ? { stamp_arrived_now: true }
        : { stamp_dispatched_now: true };
    try {
        const res = await fetch(`${API}/${reportId}/timestamps`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Timestamp failed: ${detail}`, 'error');
        }
        const updated = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        showToast(which === 'arrived' ? 'Marked arrived' : 'Marked dispatched', 'success');
        if (selectedId === reportId) selectReport(reportId, true);
        renderFeed();
    } catch (e) {
        showToast(`Timestamp error: ${e.message}`, 'error');
    }
};

// Phase 2: manual tier selection — swap the displayed variant in-place.
// Stamps `_tierOverride[reportId]` so subsequent polls / upgrades don't
// override the user's choice. Also updates the gallery thumb's active
// class + the tier switcher's active button state, and rewires the
// lightbox click handler to open the selected tier.
window.setDetailImageTier = (reportId, groupId, tier, btnEl) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const group = groupPhotos(images).find(g => g.group_id === groupId) || groupPhotos(images)[0];
    if (!group) return;
    const m = group.members.find(x => x.resolution_tier === tier && x.assembly_status === 'complete' && x.url);
    if (!m) return;
    const src = getMediaUrl(m.url);
    _tierOverride.set(reportId, tier);

    // Swap <img src> on the main detail image.
    const wrap = document.querySelector(`#dp-img-view-${reportId} .dp-img[data-group-id]`);
    if (wrap) {
        const img = wrap.querySelector('img');
        if (img && img.src !== src) {
            img.src = src;
            img.classList.remove('img-thumb-bg');
            img.classList.add('img-full-layer', 'img-ready');
        }
        wrap.setAttribute('data-current-tier', tier);
        wrap.classList.remove('dp-img-uploading');
        wrap.setAttribute('onclick',
            `openLightbox('${src.replace(/'/g, "%27")}','${(r.infrastructure_type || 'Photo')}')`);
    }

    // Update active button state inside the switcher.
    if (btnEl && btnEl.parentElement) {
        btnEl.parentElement.querySelectorAll('.dp-tier-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
};

// Phase 2: keyboard shortcuts (← / →) to cycle tiers when the detail panel
// is open and focused. Non-intrusive: falls through if focus is on an input.
document.addEventListener('keydown', (e) => {
    if (!selectedId) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const panel = document.getElementById('detail-panel');
    if (!panel || panel.style.display === 'none') return;
    const r = allReports.find(x => x.id === selectedId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const group = groupPhotos(images)[0];
    if (!group) return;
    const tiersInOrder = ['LOW', 'MEDIUM', 'HIGH'];
    const current = _tierOverride.get(selectedId) ||
        (bestVariant(group)?.tier) || 'HIGH';
    const idx = tiersInOrder.indexOf(current);
    if (idx < 0) return;
    const nextIdx = e.key === 'ArrowRight'
        ? Math.min(tiersInOrder.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    if (nextIdx === idx) return;
    const nextTier = tiersInOrder[nextIdx];
    // Only move if the target tier is complete.
    const m = group.members.find(x => x.resolution_tier === nextTier &&
                                       x.assembly_status === 'complete' && x.url);
    if (!m) return;
    const btn = document.querySelector(
        `#dp-img-view-${selectedId} .dp-tier-switcher .dp-tier-btn.dp-tier-${nextTier.toLowerCase()}`);
    window.setDetailImageTier(selectedId, group.group_id || '', nextTier, btn);
    e.preventDefault();
});

// ── Satellite Truth Verification ─────────────────────────────────────────────

/**
 * Render the verification result section inside the detail panel.
 * Called during detail-panel render if r.verification exists.
 */
function renderVerificationSection(r) {
    const v = r.verification;
    if (!v) return ''; // Not yet verified — section absent until user triggers it

    const scores   = v.scores || {};
    const total    = v.total_score || 0;
    const verdict  = v.verdict   || 'UNVERIFIED';
    const verdictLabels = {
        STRONGLY_CORROBORATED: 'Strongly Corroborated',
        LIKELY_AUTHENTIC:      'Likely Authentic',
        PARTIALLY_VERIFIED:    'Partially Verified',
        LOW_CONFIDENCE:        'Low Confidence',
        UNVERIFIED:            'Unverified',
    };

    // SVG gauge — circle r=30, circumference = 188.5
    const C      = 188.5;
    const offset = C - (total / 100) * C;
    const gaugeColor = total >= 80 ? '#22c55e'
                     : total >= 60 ? '#86efac'
                     : total >= 40 ? '#eab308'
                     : total >= 20 ? '#f97316'
                     :               '#ef4444';

    // Component bar colours (each out of 25)
    const barPct = (val) => Math.round(((val || 0) / 25) * 100);
    const barCol = (val) => val >= 20 ? '#22c55e' : val >= 13 ? '#eab308' : '#ef4444';

    // Temporal gap chip
    const gap       = v.satellite_days_gap;
    let gapChip = '';
    if (gap !== null && gap !== undefined) {
        if (gap < 0) {
            gapChip = `<span class="sat-meta-chip chip-good"><i class="fa-solid fa-calendar-check"></i> Post-incident (${Math.abs(gap)}d after)</span>`;
        } else if (gap === 0) {
            gapChip = `<span class="sat-meta-chip chip-good"><i class="fa-solid fa-calendar-day"></i> Same day</span>`;
        } else if (gap <= 7) {
            gapChip = `<span class="sat-meta-chip chip-warn"><i class="fa-solid fa-calendar"></i> ${gap}d before report</span>`;
        } else {
            gapChip = `<span class="sat-meta-chip chip-alert"><i class="fa-solid fa-calendar-xmark"></i> ${gap}d before report</span>`;
        }
    }

    // Cloud cover chip
    const cloud = v.satellite_cloud_cover_pct;
    let cloudChip = '';
    if (cloud !== null && cloud !== undefined) {
        const cls = cloud < 20 ? 'chip-good' : cloud < 50 ? 'chip-warn' : 'chip-alert';
        cloudChip = `<span class="sat-meta-chip ${cls}"><i class="fa-solid fa-cloud"></i> ${cloud}% cloud</span>`;
    } else {
        cloudChip = `<span class="sat-meta-chip chip-info"><i class="fa-solid fa-cloud"></i> Cloud: N/A</span>`;
    }

    // User photo src (first IMAGE media)
    const img = r.media?.find(m => m.type === 'IMAGE');
    const userImgSrc = img?.url ? getMediaUrl(img.url) : (img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) : '');

    const satImgSrc = v.satellite_image_url ? `${BACKEND_HOST}${v.satellite_image_url}` : '';

    // Key findings
    const findings = (v.key_findings || []).map(f =>
        `<div class="sat-finding-item"><i class="fa-solid fa-circle-dot" style="color:var(--info);"></i>${f}</div>`
    ).join('');

    // Caveats
    const caveats = (v.caveats || []).map(c =>
        `<div class="sat-caveat-item"><i class="fa-solid fa-triangle-exclamation"></i>${c}</div>`
    ).join('');

    // Scored-at time
    const scoredAt = v.scored_at ? timeAgo(v.scored_at) : '';

    return `
    <div class="detail-section" id="sat-verify-section">
        <div class="detail-section-title">
            <i class="fa-solid fa-satellite" style="color:var(--info);"></i>
            Satellite Verification
            <span style="font-size:12px; color:var(--text-dim); font-weight:400; margin-left:4px;">${scoredAt}</span>
        </div>

        ${v.error && total === 0 ? `
        <div style="padding:10px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); border-radius:8px; font-size:14px; color:#fca5a5; margin-bottom:10px;">
            <i class="fa-solid fa-triangle-exclamation"></i> ${v.error}
        </div>` : ''}

        <!-- Image comparison -->
        <div class="sat-compare-strip">
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-user"></i> Reporter Photo</div>
                ${userImgSrc
                    ? `<img src="${userImgSrc}" class="sat-compare-img" onclick="openLightbox('${userImgSrc}','User Photo')" title="Click to enlarge">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim);">No photo</div>`
                }
            </div>
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-satellite"></i> Satellite View</div>
                ${satImgSrc
                    ? `<img src="${satImgSrc}" class="sat-compare-img" onclick="openLightbox('${satImgSrc}','Satellite')" title="Click to enlarge — ${v.satellite_source || ''}">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim);">Unavailable</div>`
                }
            </div>
        </div>

        <!-- Satellite metadata chips -->
        <div class="sat-meta-row">
            <span class="sat-meta-chip chip-info"><i class="fa-solid fa-satellite-dish"></i> ${v.satellite_source || 'Unknown source'}</span>
            ${gapChip}
            ${cloudChip}
            ${v.satellite_resolution_m ? `<span class="sat-meta-chip"><i class="fa-solid fa-ruler"></i> ${v.satellite_resolution_m}m/px</span>` : ''}
        </div>

        <!-- Score gauge + verdict -->
        <div class="sat-score-block">
            <div class="sat-gauge">
                <svg width="68" height="68" viewBox="0 0 68 68">
                    <circle class="sat-gauge-track" cx="34" cy="34" r="28"/>
                    <circle class="sat-gauge-fill"
                        cx="34" cy="34" r="28"
                        stroke="${gaugeColor}"
                        stroke-dasharray="${C}"
                        stroke-dashoffset="${offset.toFixed(1)}"/>
                </svg>
                <div class="sat-gauge-label">
                    <span class="sat-gauge-num" style="color:${gaugeColor};">${total}</span>
                    <span class="sat-gauge-denom">/100</span>
                </div>
            </div>
            <div class="sat-score-info">
                <div class="sat-verdict verdict-${verdict}">${verdictLabels[verdict] || verdict}</div>
                ${v.satellite_scene_description
                    ? `<div style="font-size:12px;color:var(--text-sub);line-height:1.4;">${v.satellite_scene_description}</div>`
                    : ''}
            </div>
        </div>

        <!-- Component breakdown bars -->
        <div class="sat-components">
            <div class="sat-comp-row">
                <span class="sat-comp-label">Location Match</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.location_authenticity)}%; background:${barCol(scores.location_authenticity)};"></div></div>
                <span class="sat-comp-val">${scores.location_authenticity ?? '—'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Damage Evidence</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.damage_corroboration)}%; background:${barCol(scores.damage_corroboration)};"></div></div>
                <span class="sat-comp-val">${scores.damage_corroboration ?? '—'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Description Match</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.description_coherence)}%; background:${barCol(scores.description_coherence)};"></div></div>
                <span class="sat-comp-val">${scores.description_coherence ?? '—'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Data Quality</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.data_quality)}%; background:${barCol(scores.data_quality)};"></div></div>
                <span class="sat-comp-val">${scores.data_quality ?? '—'}/25</span>
            </div>
        </div>

        ${findings ? `<div class="sat-findings">${findings}</div>` : ''}
        ${caveats  ? `<div class="sat-findings">${caveats}</div>` : ''}

        ${v.reasoning ? `<div class="sat-reasoning">${v.reasoning}</div>` : ''}
    </div>`;
}

/**
 * Trigger verification for a report — calls POST /api/v1/reports/{id}/verify.
 * Shows loading state on the button, then refreshes the detail panel on completion.
 */
window.runVerification = async (id) => {
    const btn = document.getElementById(`btn-verify-${id}`);
    if (btn) {
        btn.classList.add('verifying');
        btn.innerHTML = '<i class="fa-solid fa-satellite fa-spin"></i> Fetching satellite...';
        btn.disabled = true;
    }
    try {
        const res = await fetch(`${API}/${id}/verify`, { method: 'POST' });
        if (res.ok) {
            const verif = await res.json();
            // Merge verification result into allReports so re-render shows it
            const idx = allReports.findIndex(r => r.id === id);
            if (idx >= 0) allReports[idx] = { ...allReports[idx], verification: verif };
            showToast(`Truth score: ${verif.total_score}/100 — ${verif.verdict?.replace(/_/g,' ')}`, 'success');
            selectReport(id, true); // re-render detail panel, skip map fly
        } else {
            const err = await res.json().catch(() => ({}));
            const errMsg = err.detail || (res.status === 503 ? 'Satellite service unavailable — check API keys' : `Server error (${res.status})`);
            showToast(`Verification failed: ${errMsg}`, 'error');
            if (btn) {
                btn.classList.remove('verifying');
                btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
                btn.disabled = false;
            }
        }
    } catch (e) {
        showToast('Verification request failed — check internet connection', 'error');
        if (btn) {
            btn.classList.remove('verifying');
            btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
            btn.disabled = false;
        }
    }
};

// ── Credibility Check (on-demand, full incident analysis) ────────────────────
window.runAIAssessment = async (id) => {
    const r = allReports.find(x => x.id === id);
    if (!r) return;

    // Block if already assessed — prevent duplicate API calls
    if (r.ai_assessment) {
        showToast('Credibility check already completed for this incident', 'info');
        return;
    }

    const topBtn = document.querySelector('.dp-run-ai-btn');
    if (topBtn) {
        topBtn.disabled = true;
        topBtn.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Analyzing…';
    }

    // Count nearby corroborating reports
    const loc = r.location;
    const nearbyReports = loc ? allReports.filter(rr => rr.id !== r.id && rr.location &&
        haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) < 5).length : 0;

    // Build full multi-signal payload for AI
    const payload = {
        id: r.id, source: r.source, severity: r.severity,
        infrastructure_type: r.infrastructure_type, status: r.status,
        description: r.description || '',
        transcription: r.ai_analysis?.transcription || '',
        ai_summary: r.ai_analysis?.ai_summary || '',
        location: loc ? { lat: loc.latitude, lng: loc.longitude, name: loc.user_location_name || loc.device_location_name || '' } : null,
        media_count: r.media?.length || 0,
        has_image: !!r.media?.find(m => m.type === 'IMAGE'),
        has_audio: !!r.media?.find(m => m.type === 'AUDIO'),
        verification: r.verification ? {
            score: r.verification.total_score, verdict: r.verification.verdict,
            scores: r.verification.scores || {},
            photo_analysis: r.verification.photo_analysis || '',
            satellite_scene: r.verification.satellite_scene_description || '',
            key_findings: r.verification.key_findings || [],
            caveats: r.verification.caveats || [],
        } : null,
        caller_info: r.caller_info || null,
        nearby_reports: nearbyReports,
    };

    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/reports/${id}/ai-assess`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        if (res.ok) {
            const data = await res.json();
            const summary = data.summary || 'No summary available.';
            const details = data.details || '';
            const action = data.suggested_action || '';
            const confScore = data.confidence_score ?? null;
            const actionColor = action.includes('Dispatch') ? '#22c55e' : action.includes('False') ? '#ef4444' : action.includes('Suspicious') ? '#f97316' : action.includes('Monitor') ? '#eab308' : '#94a3b8';
            // Store in report object and update classification from AI inference
            const idx = allReports.findIndex(x => x.id === id);
            if (idx >= 0) {
                allReports[idx].ai_assessment = data;
                // Update type/severity from AI (replaces old AI Extractor)
                if (data.inferred_type) allReports[idx].infrastructure_type = data.inferred_type;
                if (data.inferred_severity) allReports[idx].severity = data.inferred_severity;
            }
            // Re-render — top bar shows AI score, tree view updates type/severity
            selectReport(id, true);
            renderFeed();
            showToast(`Credibility: ${confScore}/100 — ${action}`, 'success');
        } else {
            showToast('Credibility check failed', 'error');
            if (topBtn) { topBtn.disabled = false; topBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Credibility Check'; }
        }
    } catch (e) {
        showToast('Credibility check request failed', 'error');
        if (topBtn) { topBtn.disabled = false; topBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Credibility Check'; }
    }
};

// ── PDF Export ────────────────────────────────────────────────────────────────
window.exportPDF = (id) => {
    const r = allReports.find(x => x.id === id);
    if (!r) return;
    const loc = r.location;
    const ai = r.ai_analysis;
    const v = r.verification;
    const ci = r.caller_info;
    const locName = loc?.user_location_name || loc?.device_location_name || (loc ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}` : 'Unknown');
    const srcLabel = {APP:'Mobile App',ANDROID:'Android App',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[r.source] || r.source;
    const ts = new Date(ensureUTC(r.server_created_at)).toLocaleString();

    // Gather all image URLs: user photo + primary satellite + alt satellite
    const imgMedia = r.media?.find(m => m.type === 'IMAGE' && m.assembly_status === 'complete' && m.url);
    const userImgUrl = imgMedia ? `${BACKEND_HOST}${imgMedia.url.startsWith('/') ? '' : '/static/'}${imgMedia.url.replace('/static/','')}` : '';
    const satImgUrl = v?.satellite_image_url ? `${BACKEND_HOST}${v.satellite_image_url}` : '';
    const satAltImgUrl = v?.satellite_image_url_alt ? `${BACKEND_HOST}${v.satellite_image_url_alt}` : '';
    const satSource1 = (v?.satellite_source || 'Satellite').split('(')[0].trim();
    const satSource2 = (v?.satellite_source_alt || 'Alt Satellite').split('(')[0].trim();
    const satDate1 = v?.satellite_acquisition_date ? new Date(v.satellite_acquisition_date).toLocaleDateString() : '';
    const satDate2 = v?.satellite_acquisition_date_alt ? new Date(v.satellite_acquisition_date_alt).toLocaleDateString() : '';
    const satRes1 = v?.satellite_resolution_m ? `${v.satellite_resolution_m}m` : '';
    const satRes2 = v?.satellite_resolution_m_alt ? `${v.satellite_resolution_m_alt}m` : '';
    const hasAnyImage = userImgUrl || satImgUrl || satAltImgUrl;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CRISP Incident Report — ${r.id.substring(0,8)}</title>
    <style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:28px 32px;max-width:800px;margin:0 auto;color:#1e293b;font-size:13px;}
      .hdr{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #7c3aed;padding-bottom:12px;margin-bottom:18px;}
      .hdr h1{font-size:20px;color:#7c3aed;letter-spacing:-0.3px;}.hdr .rid{font-size:11px;color:#64748b;font-family:monospace;display:block;margin-top:2px;}
      .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;margin-right:4px;}
      .sev-CRITICAL,.sev-SEVERE{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;}
      .sev-MODERATE{background:#fffbeb;color:#d97706;border:1px solid #fde68a;}.sev-MINOR{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;}
      .section{margin-bottom:14px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;}
      .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#475569;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px;}
      .row{display:flex;justify-content:space-between;padding:3px 0;font-size:12px;}.row .k{color:#64748b;font-weight:600;}.row .v{color:#1e293b;}
      .desc{font-size:13px;line-height:1.6;color:#334155;white-space:pre-wrap;}
      .img-grid{display:flex;gap:10px;margin-top:8px;}
      .img-card{flex:1;text-align:center;min-width:0;}
      .img-card img{width:100%;height:180px;border-radius:6px;border:1px solid #e2e8f0;object-fit:cover;}
      .img-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#475569;margin-top:5px;}
      .img-ts{font-size:9px;color:#94a3b8;margin-top:1px;}
      .print-bar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:16px;}
      .print-bar button{padding:8px 18px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;}
      .btn-print{background:#7c3aed;color:#fff;}.btn-save{background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;}
      .footer{margin-top:24px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:10px;color:#94a3b8;text-align:center;}
      @media print{.print-bar{display:none !important;}body{padding:12px;}}
    </style></head><body>

    <div class="print-bar">
      <button class="btn-save" onclick="document.title='CRISP-Report-${r.id.substring(0,8)}';window.print();">Save as PDF</button>
      <button class="btn-print" onclick="window.print();">Print</button>
    </div>

    <div class="hdr"><div><h1>CRISP Incident Report</h1><span class="rid">ID: ${r.id}</span></div><div style="text-align:right;"><div style="font-size:13px;font-weight:700;">${r.infrastructure_type.replace(/_/g,' ')}</div><span class="badge sev-${r.severity}">${r.severity}</span><span class="badge" style="background:#f1f5f9;border:1px solid #cbd5e1;">${r.status}</span></div></div>

    <div class="section"><div class="section-title">Incident Overview</div>
      <div class="row"><span class="k">Type</span><span class="v">${r.infrastructure_type.replace(/_/g,' ')}</span></div>
      <div class="row"><span class="k">Severity</span><span class="v">${r.severity}</span></div>
      <div class="row"><span class="k">Status</span><span class="v">${r.status}</span></div>
      <div class="row"><span class="k">Source</span><span class="v">${srcLabel}</span></div>
      <div class="row"><span class="k">Reported</span><span class="v">${ts}</span></div>
      ${ci?.phone ? `<div class="row"><span class="k">Caller</span><span class="v">${ci.phone}</span></div>` : ''}
    </div>

    <div class="section"><div class="section-title">Location</div>
      <div class="row"><span class="k">Name</span><span class="v">${locName}</span></div>
      ${loc ? `<div class="row"><span class="k">Coordinates</span><span class="v">${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}</span></div>` : ''}
      ${ci?.network_location ? `<div class="row"><span class="k">Telecom Circle</span><span class="v">${ci.network_location}</span></div>` : ''}
    </div>

    <div class="section"><div class="section-title">Description</div>
      <div class="desc">${r.description || ai?.transcription || 'No description available.'}</div>
    </div>

    ${hasAnyImage ? `
    <div class="section"><div class="section-title">Visual Evidence</div>
      <div class="img-grid">
        ${userImgUrl ? `<div class="img-card"><img src="${userImgUrl}" onerror="this.parentElement.style.display='none'"><div class="img-label">Reported Photo</div><div class="img-ts">${ts}</div></div>` : ''}
        ${satImgUrl ? `<div class="img-card"><img src="${satImgUrl}" onerror="this.parentElement.style.display='none'"><div class="img-label">${satSource1}</div><div class="img-ts">${satDate1}${satRes1 ? ' · ' + satRes1 + ' res' : ''}</div></div>` : ''}
        ${satAltImgUrl ? `<div class="img-card"><img src="${satAltImgUrl}" onerror="this.parentElement.style.display='none'"><div class="img-label">${satSource2}</div><div class="img-ts">${satDate2}${satRes2 ? ' · ' + satRes2 + ' res' : ''}</div></div>` : ''}
      </div>
    </div>` : ''}

    ${ai?.ai_summary ? `<div class="section"><div class="section-title">AI Analysis</div><div class="desc">${ai.ai_summary}</div></div>` : ''}

    ${v ? `<div class="section"><div class="section-title">Satellite Verification</div>
      <div class="row"><span class="k">Score</span><span class="v" style="font-weight:700;">${v.total_score}/100</span></div>
      <div class="row"><span class="k">Verdict</span><span class="v">${(v.verdict || '').replace(/_/g,' ')}</span></div>
      ${v.key_findings?.length ? `<div style="margin-top:6px;font-size:12px;"><strong>Findings:</strong><ul style="margin:4px 0 0 16px;">${v.key_findings.map(f=>'<li>'+f+'</li>').join('')}</ul></div>` : ''}
    </div>` : ''}

    <div class="section"><div class="section-title">Media Summary</div>
      <div class="row"><span class="k">Attachments</span><span class="v">${r.received_media} of ${r.expected_media} received</span></div>
      <div class="row"><span class="k">Images</span><span class="v">${r.media?.filter(m=>m.type==='IMAGE').length || 0}</span></div>
      <div class="row"><span class="k">Audio Recordings</span><span class="v">${r.media?.filter(m=>m.type==='AUDIO').length || 0}</span></div>
    </div>

    <div class="footer">Generated by CRISP — Crisis Response Intelligence & Situation Platform · ${new Date().toLocaleString()}</div>
    </body></html>`;

    const w = window.open('', '_blank', 'width=850,height=1100');
    w.document.write(html);
    w.document.close();
};

// ── Report Actions ───────────────────────────────────────────────────────────
window.patchReport = async (id, action) => {
    try {
        const res = await fetch(`${API}/${id}/${action}`, { method: 'PATCH' });
        if (res.ok) {
            const updated = await res.json();
            const idx = allReports.findIndex(r => r.id === id);
            if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
            showToast(`Report ${action}ed successfully`, 'success');
            if (selectedId === id) selectReport(id);
            renderFeed();
        }
    } catch (e) { showToast('Action failed — check internet connection', 'error'); }
};

window.deleteReport = async (id) => {
    try {
        const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
        if (res.ok || res.status === 204) {
            allReports = allReports.filter(r => r.id !== id);
            knownIds.delete(id);
            // Phase 2: clear any tier override for the deleted report so
            // a later report with the same id (re-imported) starts fresh.
            _tierOverride.delete(id);
            if (selectedId === id) closeDetail();
            showToast('Report deleted', 'success');
            updateMapMarkers();
            renderFeed();
        }
    } catch (e) { showToast('Delete failed', 'error'); }
};

// ── Building History (Apr 2026 UI v2.1 W4) ─────────────────────────────────
// Endpoint response shape is now:
//   { building_id, total, latest_id, reports: [ ...ordinal-augmented... ] }
// Each report carries `building_version_ordinal` (1-based, 1=latest) and
// `building_is_latest` so the detail panel can paint the "V 2 of 3 · latest"
// ribbon. Legacy list-shaped responses are still accepted (older backends)
// via an Array.isArray branch, so we don't break during a rolling deploy.
// Phase 1 (Apr 2026 — Optional reporter login) — reporter-profile drawer.
// Calls `/auth/users/{user_id}` which is gated to ADMIN role on the
// server; ANALYST sessions get 403 and we show a short info toast.
// Masked "User abc12345" already rendered in the row badge for everyone;
// this drawer is the PII-unmask path for admins only.
window.openReporterProfile = async (userId) => {
    if (!userId) return;
    try {
        const res = await fetch(`${API}/auth/users/${userId}`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
        });
        if (res.status === 403) {
            try { window.__toast && window.__toast('Only administrators can see reporter PII.', 'info'); } catch (_) {}
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const lines = [
            `User: ${data.id}`,
            data.email ? `Email: ${data.email}` : '',
            data.phone_number ? `Phone: ${data.phone_number}` : '',
            data.role ? `Role: ${data.role}` : '',
            data.last_login_at ? `Last login: ${data.last_login_at}` : '',
        ].filter(Boolean).join('\n');
        alert(lines || 'No reporter details available.');
    } catch (e) {
        console.warn('[Reporter] fetch failed:', e);
    }
};

window.filterByBuilding = async (buildingId) => {
    try {
        const res = await fetch(`${API}/building/${buildingId}`);
        if (!res.ok) { showToast('Could not load building history', 'error'); return; }
        const body = await res.json();
        const reports = Array.isArray(body) ? body : (body.reports || []);
        const total = Array.isArray(body) ? reports.length : (body.total || reports.length);
        if (reports.length <= 1) { showToast('Only 1 report for this building', 'info'); return; }
        showToast(`Building has ${total} reports (v${total} → v1, latest first)`, 'success');
        // Highlight all building reports on map
        reports.forEach(rep => { const marker = clusterGroup.getLayers().find(m => m._crispReport?.id === rep.id); if (marker) marker.openPopup(); });
        // Cache the version index so the detail panel renderer can look
        // up a report's ordinal without another fetch. Keyed by report-id.
        if (!window._buildingVersionIndex) window._buildingVersionIndex = {};
        reports.forEach(rep => {
            window._buildingVersionIndex[rep.id] = {
                ordinal: rep.building_version_ordinal,
                total: total,
                is_latest: !!rep.building_is_latest,
                building_id: buildingId,
            };
        });
        return body;
    } catch (e) { showToast('Building history error', 'error'); }
};

/**
 * Fetch-and-cache the building version index for a report. Used by the
 * detail-panel render when it wants the ribbon but doesn't know the
 * building-history yet. Idempotent; subsequent calls return the cache.
 */
window.ensureBuildingVersionIndex = async (report) => {
    if (!report || !report.building_id) return null;
    const idx = window._buildingVersionIndex || {};
    if (idx[report.id]) return idx[report.id];
    try {
        const res = await fetch(`${API}/building/${report.building_id}`);
        if (!res.ok) return null;
        const body = await res.json();
        const reports = Array.isArray(body) ? body : (body.reports || []);
        const total = reports.length;
        if (!window._buildingVersionIndex) window._buildingVersionIndex = {};
        reports.forEach(rep => {
            window._buildingVersionIndex[rep.id] = {
                ordinal: rep.building_version_ordinal || (reports.indexOf(rep) + 1),
                total: total,
                is_latest: !!rep.building_is_latest || rep === reports[0],
                building_id: report.building_id,
            };
        });
        return window._buildingVersionIndex[report.id] || null;
    } catch (_) { return null; }
};

// ── AI Logic Transparency Modal ──────────────────────────────────────────────
window.showAILogic = function (reportId) {
    const r = allReports.find(rr => rr.id === reportId);
    if (!r || !r.ai_assessment) return;
    const aa = r.ai_assessment;
    const sb = aa.score_breakdown || {};

    const barHtml = (label, val, max = 100) => {
        const pct = Math.min(100, Math.max(0, (val / max) * 100));
        const color = val >= 70 ? '#22c55e' : val >= 50 ? '#eab308' : val >= 30 ? '#f97316' : '#ef4444';
        return `<div class="ai-logic-bar-row">
            <span class="ai-logic-label">${label}</span>
            <div class="ai-logic-bar"><div class="ai-logic-bar-fill" style="width:${pct}%;background:${color};"></div></div>
            <span class="ai-logic-val" style="color:${color};">${val}</span>
        </div>`;
    };

    const bonusHtml = (label, val) => {
        if (!val) return '';
        const color = val > 0 ? '#22c55e' : val < 0 ? '#ef4444' : '#64748b';
        return `<div class="ai-logic-bonus"><span>${label}</span><span style="color:${color};font-weight:700;">${val > 0 ? '+' : ''}${val}</span></div>`;
    };

    const modal = document.createElement('div');
    modal.className = 'ai-logic-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="ai-logic-card">
            <div class="ai-logic-header">
                <h3><i class="fa-solid fa-shield-halved"></i> Credibility Assessment Logic</h3>
                <button onclick="this.closest('.ai-logic-overlay').remove()" class="ai-logic-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="ai-logic-body">
                <div class="ai-logic-section">
                    <h4>Score Breakdown</h4>
                    ${barHtml('Text & Voice', sb.text_voice_score || 0)}
                    ${barHtml('Visual Evidence', sb.visual_evidence_score || 0)}
                    ${barHtml('Satellite Verification', sb.satellite_score || 0)}
                    ${barHtml('Corroboration', sb.corroboration_score || 0)}
                    <div class="ai-logic-divider"></div>
                    ${bonusHtml('Reporter Credibility', sb.credibility_bonus)}
                    ${bonusHtml('Infrastructure Criticality', sb.criticality_bonus)}
                    ${bonusHtml('Penalties', sb.penalties)}
                    <div class="ai-logic-divider"></div>
                    <div class="ai-logic-total">
                        <span>Final Score</span>
                        <span style="font-size:24px;font-weight:800;color:${(sb.final_score || aa.confidence_score || 0) >= 70 ? '#22c55e' : '#f97316'};">
                            ${sb.final_score || aa.confidence_score || '?'}<small>/100</small>
                        </span>
                    </div>
                </div>
                ${(aa.key_factors || []).length ? `<div class="ai-logic-section"><h4>Key Factors</h4><ul>${aa.key_factors.map(f => `<li><i class="fa-solid fa-check" style="color:#22c55e;"></i> ${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
                ${(aa.risk_flags || []).length ? `<div class="ai-logic-section"><h4>Risk Flags</h4><ul>${aa.risk_flags.map(f => `<li><i class="fa-solid fa-triangle-exclamation" style="color:#f97316;"></i> ${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
                <div class="ai-logic-section"><h4>Full Reasoning</h4><p class="ai-logic-reasoning">${escapeHtml(aa.reasoning || aa.details || 'No detailed reasoning available.')}</p></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

// ── Audio Player ─────────────────────────────────────────────────────────────
window.playDetailAudio = function (btn, url) {
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('playing');
        if (currentAudio._url === url) { currentAudio = null; return; }
    }
    // Cache-bust so re-clicks fetch the latest partial file from disk
    const fetchUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
    currentAudio = new Audio(fetchUrl);
    currentAudio._url = url;
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    btn.classList.add('playing');
    currentAudio.play();

    currentAudio.ontimeupdate = () => {
        const fill = document.getElementById('detail-audio-fill');
        const cur = document.getElementById('detail-audio-cur');
        if (fill && currentAudio.duration && isFinite(currentAudio.duration)) {
            fill.style.width = `${(currentAudio.currentTime / currentAudio.duration) * 100}%`;
        }
        if (cur) cur.textContent = formatTime(currentAudio.currentTime);
    };
    currentAudio.onloadedmetadata = () => {
        const dur = document.getElementById('detail-audio-dur');
        if (dur) dur.textContent = isFinite(currentAudio.duration) ? formatTime(currentAudio.duration) : '—:——';
    };
    currentAudio.onended = () => {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('playing');
    };
};

function formatTime(s) {
    if (!s || !isFinite(s) || isNaN(s)) return '—:——';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
window.openLightbox = function (url, caption) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <button class="lightbox-close" onclick="this.parentElement.remove()"><i class="fa-solid fa-xmark"></i></button>
        <img src="${url}" alt="${caption}">
        <div class="lightbox-caption">${caption}</div>
    `;
    document.body.appendChild(overlay);
};

// ── Map ──────────────────────────────────────────────────────────────────────
let map;

function initMap() {
    map = L.map('crisis-map', {
        zoomControl: false,
        minZoom: 2,
        maxBounds: [[-85, -180], [85, 180]],
        maxBoundsViscosity: 1.0,
    }).setView([20, 0], 2);
    const darkTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19, noWrap: true,
    });
    const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri World Imagery', maxZoom: 19, noWrap: true,
    });
    const streetTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19, noWrap: true,
    });
    darkTiles.addTo(map);
    L.control.layers({ "Dark": darkTiles, "Satellite": satelliteTiles, "Street": streetTiles }, null, { position: 'topright' }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Building footprints layer — loads from Overpass API at zoom >= 15
    let _buildingLayer = null;
    let _buildingCache = {};
    let _buildingDebounce = null;
    function loadBuildingFootprints() {
        if (map.getZoom() < 15) { if (_buildingLayer) { map.removeLayer(_buildingLayer); _buildingLayer = null; } return; }
        const b = map.getBounds();
        const key = `${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`;
        if (_buildingCache[key]) return;
        const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
        const query = `[out:json][timeout:10];way["building"](${bbox});out geom;`;
        fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`)
            .then(r => r.json())
            .then(data => {
                _buildingCache[key] = true;
                const features = (data.elements || []).filter(e => e.geometry).map(e => ({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [e.geometry.map(p => [p.lon, p.lat])] },
                    properties: { name: e.tags?.name || '', type: e.tags?.building || 'yes' },
                }));
                if (_buildingLayer) map.removeLayer(_buildingLayer);
                _buildingLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
                    style: { color: '#7c3aed', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.15 },
                    onEachFeature: (f, layer) => { if (f.properties.name) layer.bindTooltip(f.properties.name, { sticky: true }); },
                }).addTo(map);
            })
            .catch(() => {});
    }
    map.on('moveend', () => { clearTimeout(_buildingDebounce); _buildingDebounce = setTimeout(loadBuildingFootprints, 600); });

    // Initialize cluster group — optimized for easy clicking on hotspots
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 35,
        spiderfyOnMaxZoom: true,
        spiderfyDistanceMultiplier: 2.5,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: false,     // we handle click ourselves — spiderfy on click
        disableClusteringAtZoom: 16,
        iconCreateFunction: function (cluster) {
            const children = cluster.getAllChildMarkers();
            let maxSev = 'UNKNOWN';
            const sevOrder = ['UNKNOWN', 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'];
            children.forEach(m => {
                if (m._crispReport && sevOrder.indexOf(m._crispReport.severity) > sevOrder.indexOf(maxSev)) {
                    maxSev = m._crispReport.severity;
                }
            });
            const color = SEV_COLORS[maxSev] || '#64748b';
            const count = children.length;
            const size = count > 50 ? 52 : count > 20 ? 44 : count > 5 ? 38 : 32;
            const hasCritical = children.some(m => m._crispReport?.severity === 'CRITICAL');
            const pulseClass = hasCritical ? 'crisp-cluster-pulse' : '';
            return L.divIcon({
                className: `crisp-cluster ${pulseClass}`,
                html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;font-size:${size > 40 ? 15 : 13}px;font-weight:800;color:#fff;box-shadow:0 2px 16px ${color}aa;cursor:pointer;">${count}</div>`,
                iconSize: [size, size]
            });
        }
    });
    map.addLayer(clusterGroup);

    // Cluster hover: show popup with incidents grouped by infrastructure type
    clusterGroup.on('clustermouseover', function (e) {
        const cluster = e.layer;
        const children = cluster.getAllChildMarkers();

        // Group by infrastructure type
        const groups = {};
        children.forEach(m => {
            const r = m._crispReport;
            if (!r) return;
            const type = r.infrastructure_type || 'OTHER';
            if (!groups[type]) groups[type] = { count: 0, maxSev: 'UNKNOWN', sevCounts: {} };
            groups[type].count++;
            groups[type].sevCounts[r.severity] = (groups[type].sevCounts[r.severity] || 0) + 1;
            const sevOrder = ['UNKNOWN', 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'];
            if (sevOrder.indexOf(r.severity) > sevOrder.indexOf(groups[type].maxSev)) groups[type].maxSev = r.severity;
        });

        const rows = Object.entries(groups)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([type, g]) => {
                const ic = INFRA_ICONS[type] || 'fa-circle';
                const col = SEV_COLORS[g.maxSev] || '#64748b';
                const sevDots = Object.entries(g.sevCounts).map(([s, c]) =>
                    `<span style="color:${SEV_COLORS[s] || '#64748b'};font-size:10px;" title="${s}: ${c}">${'●'.repeat(Math.min(c, 5))}</span>`
                ).join(' ');
                return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <i class="fa-solid ${ic}" style="color:${col};font-size:13px;width:16px;text-align:center;"></i>
                    <span style="font-size:12px;color:#f1f5f9;font-weight:600;flex:1;">${type.replace(/_/g,' ')}</span>
                    <span style="font-size:13px;font-weight:800;color:${col};min-width:18px;text-align:right;">${g.count}</span>
                </div>`;
            }).join('');

        const locName = children[0]?._crispReport?.location?.user_location_name || children[0]?._crispReport?.location?.device_location_name || '';
        cluster.bindPopup(`<div style="min-width:190px;max-width:260px;">
            <div style="font-size:13px;font-weight:800;color:#ffae00;margin-bottom:6px;">${children.length} Incidents${locName ? ' — ' + locName : ''}</div>
            ${rows}
            <div style="font-size:10px;color:#64748b;text-align:center;margin-top:6px;"><i class="fa-solid fa-hand-pointer"></i> Click to expand</div>
        </div>`, { className: 'cluster-popup', closeButton: false, autoPan: false }).openPopup();
    });

    clusterGroup.on('clustermouseout', function (e) {
        e.layer.closePopup();
    });

    // Track spiderfy state — exposed on window so updateMapMarkers can skip rebuild
    window._spiderfiedCluster = null;
    let _spiderfyLock = false;

    clusterGroup.on('clusterclick', function (e) {
        e.layer.closePopup();
        // If clicking the same cluster that's already spiderfied, close it
        if (window._spiderfiedCluster === e.layer) {
            e.layer.unspiderfy();
            window._spiderfiedCluster = null;
            return;
        }
        // Close any previously spiderfied cluster
        if (window._spiderfiedCluster) {
            try { window._spiderfiedCluster.unspiderfy(); } catch (_) {}
        }
        _spiderfyLock = true;
        window._spiderfiedCluster = e.layer;
        e.layer.spiderfy();
        setTimeout(() => { _spiderfyLock = false; }, 500);
    });

    // Click on map background: close spider
    map.on('click', function () {
        if (_spiderfyLock) return;
        if (window._spiderfiedCluster) {
            try { window._spiderfiedCluster.unspiderfy(); } catch (_) {}
            window._spiderfiedCluster = null;
        }
    });

    // When cluster unspiderfies (by any means), clear our reference
    clusterGroup.on('unspiderfied', function () {
        window._spiderfiedCluster = null;
    });
}

function updateMapMarkers() {
    // Skip full map rebuild while a spider is open — user is interacting with it
    if (window._spiderfiedCluster) return;

    clusterGroup.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    const heatPoints = [];
    const filteredReports = _getFilteredReports();

    filteredReports.forEach(r => {
        if (!r.location) return;
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const color = SEV_COLORS[r.severity] || '#64748b';

        // Marker with infrastructure category icon
        const infraIc = INFRA_ICONS[r.infrastructure_type] || 'fa-circle';
        const markerIcon = L.divIcon({
            className: 'crisp-marker',
            html: `<div class="crisp-marker-pin" style="background:${color};box-shadow:0 2px 12px ${color}aa;">
                <i class="fa-solid ${infraIc}"></i>
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });
        const marker = L.marker([lat, lng], { icon: markerIcon });
        marker._crispReport = r;
        marker.on('click', () => selectReport(r.id));

        // Tooltip on hover
        marker.bindTooltip(() => {
            const img = r.media?.find(m => m.type === 'IMAGE');
            return `<div style="padding:8px;min-width:180px;">
                ${img ? `<img src="${getMediaUrl(img.url)}" style="width:100%;height:70px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ''}
                <div style="font-weight:700;font-size:14px;color:${color};">${r.severity} — ${r.infrastructure_type}</div>
                <div style="font-size:13px;color:#94a3b8;margin-top:2px;">${(r.description || '').substring(0, 60)}</div>
                <div style="font-size:12px;color:#475569;margin-top:4px;">${timeAgo(r.server_created_at)}</div>
            </div>`;
        }, { className: 'rich-tooltip', direction: 'top', offset: [0, -8] });

        clusterGroup.addLayer(marker);

        // Heat data
        const intensity = (SEV_SCORE[r.severity] || 1) / 10;
        heatPoints.push([lat, lng, intensity]);
    });

    // Heat layer — guard against zero-size canvas (can throw getImageData error)
    if (heatPoints.length > 0) {
        try {
            heatLayer = L.heatLayer(heatPoints, {
                radius: 30, blur: 20, maxZoom: 10,
                gradient: { 0.2: '#22c55e', 0.4: '#eab308', 0.6: '#f97316', 0.8: '#ef4444', 1.0: '#dc2626' }
            }).addTo(map);
        } catch (_) { /* map not fully sized yet — heat layer will be added on next update */ }
    }

    // Auto-zoom on first load
    if (!firstZoomDone && filteredReports.some(r => r.location)) {
        const pts = filteredReports.filter(r => r.location).map(r => [r.location.latitude, r.location.longitude]);
        map.flyToBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 10 });
        firstZoomDone = true;
    }
}

function focusMapOnNode(path) {
    // Clear old boundaries
    boundaryLayers.forEach(l => map.removeLayer(l));
    boundaryLayers = [];

    const parts = path.split('|');
    let cur = buildControlPanelTree(allReports);
    for (const p of parts) { if (cur && cur[p]) cur = cur[p]; else return; }

    const incs = collectIncidents(cur).filter(r => r.location);
    if (incs.length === 0) return;

    const latlngs = incs.map(r => [r.location.latitude, r.location.longitude]);
    const bounds = L.latLngBounds(latlngs);

    // Draw boundary circle/rectangle
    if (incs.length === 1) {
        const c = L.circle(latlngs[0], {
            radius: 1000, color: '#ffae00', fillColor: '#ffae00',
            fillOpacity: 0.08, weight: 2, dashArray: '6,4'
        }).addTo(map);
        boundaryLayers.push(c);
    } else {
        // Adaptive boundary
        const center = bounds.getCenter();
        const corner = bounds.getNorthEast();
        const radius = center.distanceTo(corner) * 1.2;
        const c = L.circle(center, {
            radius: Math.max(radius, 500), color: '#ffae00', fillColor: '#ffae00',
            fillOpacity: 0.06, weight: 2, dashArray: '8,5'
        }).addTo(map);
        boundaryLayers.push(c);
    }

    map.flyToBounds(bounds.pad(0.3), { maxZoom: 14 });
}

// ── Pending Deletions Admin View ─────────────────────────────────────────────
let _pendingDeletions = [];

async function _checkPendingDeletions() {
    try {
        const res = await fetch(`${API}/?include_deleted=true`);
        if (!res.ok) return;
        const all = await res.json();
        _pendingDeletions = all.filter(r => r.deletion_requested_at);
        const btn = document.getElementById('btn-pending-deletions');
        const badge = document.getElementById('deletion-count-badge');
        if (btn && badge) {
            btn.style.display = _pendingDeletions.length > 0 ? 'inline-flex' : 'none';
            badge.textContent = _pendingDeletions.length;
        }
    } catch (_) {}
}

window.showPendingDeletions = function () {
    const panel = document.getElementById('deletions-panel');
    const body = document.getElementById('del-panel-body');
    if (!panel || !body) return;
    panel.style.display = 'flex';

    // Bug-fix: always clear the footer first so an empty list can't leave a
    // stale "Purge All (1)" button on screen from the previous render.
    const footerEl = document.getElementById('del-panel-footer');
    if (footerEl) footerEl.innerHTML = '';

    if (_pendingDeletions.length === 0) {
        body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);"><i class="fa-solid fa-circle-check" style="font-size:24px;color:#22c55e;"></i><br>No pending deletions</div>';
        return;
    }

    const expiredCount = _pendingDeletions.filter(r => {
        const delAt = new Date(ensureUTC(r.deletion_requested_at));
        return (Date.now() - delAt.getTime()) > 86400000;
    }).length;

    body.innerHTML = _pendingDeletions.map(r => {
        const delAt = new Date(ensureUTC(r.deletion_requested_at));
        const expiresAt = new Date(delAt.getTime() + 24 * 60 * 60 * 1000);
        const remaining = Math.max(0, expiresAt - Date.now());
        const hrs = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        const countdown = remaining > 0 ? `${hrs}h ${mins}m remaining` : 'Expired — awaiting purge';
        const expired = remaining <= 0;
        const loc = r.location?.user_location_name || r.location?.device_location_name || 'Unknown';
        const sevColor = SEV_COLORS[r.severity] || '#64748b';

        return `<div class="del-item ${expired ? 'del-expired' : ''}">
            <div class="del-item-info">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="color:${sevColor};font-weight:700;">${r.infrastructure_type}</span>
                    <span class="detail-sev-badge detail-sev-${r.severity}" style="font-size:12px;padding:1px 8px;">${r.severity}</span>
                </div>
                <div style="font-size:14px;color:var(--text-sub);margin-top:2px;">${loc} · ${timeAgo(r.server_created_at)}</div>
                <div style="font-size:13px;color:${expired ? '#ef4444' : '#f59e0b'};margin-top:4px;display:flex;align-items:center;gap:4px;">
                    <i class="fa-solid ${expired ? 'fa-clock' : 'fa-hourglass-half'}"></i>
                    Deletion requested ${timeAgo(r.deletion_requested_at)} · ${countdown}
                </div>
                <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">Device: ${r.device_id?.substring(0, 8)}... · ID: ${r.id.substring(0, 8)}...</div>
            </div>
        </div>`;
    }).join('');

    // Footer with purge button
    const footer = document.getElementById('del-panel-footer');
    if (footer) {
        footer.innerHTML = `
            <div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border);">
                <button class="dp-dock-btn" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);flex:1;" onclick="purgeAllDeletions()">
                    <i class="fa-solid fa-trash"></i> Purge All (${_pendingDeletions.length})
                </button>
                ${expiredCount > 0 ? `<button class="dp-dock-btn" style="background:rgba(249,115,22,0.12);color:#f97316;border:1px solid rgba(249,115,22,0.25);flex:1;" onclick="purgeExpiredOnly()">
                    <i class="fa-solid fa-clock"></i> Purge Expired (${expiredCount})
                </button>` : ''}
            </div>
        `;
    }
};

window.closeDeletionsPanel = function () {
    const panel = document.getElementById('deletions-panel');
    if (panel) panel.style.display = 'none';
};

// ── Phase 4 (Apr 2026) — Auto-Submit Regions Admin Panel ─────────────────────
// Admin toggles enable per-region 2-minute auto-submit countdowns on clients.
// Uses JWT (not X-Admin-Key) — the global fetch wrapper at line 27 handles
// the Authorization header automatically for any /api/ request.

let _regionsCache = [];
let _regionEditingId = null;   // null when creating, uuid when editing

/** Show the Regions button to ADMIN / SUPER_ADMIN only. */
function _maybeShowRegionsButton() {
    const u = _crispUser;
    const role = (u && u.role) || '';
    const btn = document.getElementById('btn-auto-regions');
    if (btn && (role === 'ADMIN' || role === 'SUPER_ADMIN')) {
        btn.style.display = 'inline-flex';
    }
}
// Expose so _initUserMenu (called on DOMContentLoaded) can invoke it.
window._maybeShowRegionsButton = _maybeShowRegionsButton;

window.showRegionsPanel = async function () {
    const panel = document.getElementById('regions-panel');
    const body = document.getElementById('regions-panel-body');
    if (!panel || !body) return;
    panel.style.display = 'block';
    body.innerHTML = '<div style="padding:20px;color:#9ca3af;">Loading…</div>';
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/admin/regions`);
        if (!res.ok) {
            body.innerHTML = `<div style="padding:20px;color:#ef4444;">Failed to load regions (${res.status})</div>`;
            return;
        }
        _regionsCache = await res.json();
        _renderRegionsList();
    } catch (e) {
        body.innerHTML = `<div style="padding:20px;color:#ef4444;">Error: ${e.message}</div>`;
    }
};

window.closeRegionsPanel = function () {
    const panel = document.getElementById('regions-panel');
    if (panel) panel.style.display = 'none';
};

function _renderRegionsList() {
    const body = document.getElementById('regions-panel-body');
    if (!body) return;
    if (!_regionsCache.length) {
        body.innerHTML = `<div style="padding:20px;color:#94a3b8;">
            No auto-submit regions configured yet.<br><br>
            Click <b>Add region</b> to create one. Enabled regions show a
            2-minute auto-submit timer on every client whose GPS falls inside
            their radius.
        </div>`;
        return;
    }
    body.innerHTML = _regionsCache.map(r => {
        const radiusKm = (r.radius_meters / 1000).toFixed(1);
        const lat = r.center_lat.toFixed(4);
        const lng = r.center_lng.toFixed(4);
        const chipClass = r.enabled ? 'region-chip-on' : 'region-chip-off';
        const chipLabel = r.enabled ? 'ENABLED' : 'disabled';
        return `<div class="region-row" data-id="${r.id}">
            <div class="region-row-main">
                <div class="region-row-name"><b>${_esc(r.name)}</b>
                    <span class="region-chip ${chipClass}">${chipLabel}</span></div>
                <div class="region-row-meta">
                    ${lat}°, ${lng}° · ${radiusKm} km radius
                </div>
            </div>
            <div class="region-row-actions">
                <button class="btn btn-secondary" onclick="toggleRegion('${r.id}')" title="${r.enabled ? 'Disable' : 'Enable'}">
                    <i class="fa-solid ${r.enabled ? 'fa-pause' : 'fa-play'}"></i>
                </button>
                <button class="btn btn-secondary" onclick="openRegionForm('${r.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="btn btn-danger" onclick="deleteRegion('${r.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }).join('');
}

function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.openRegionForm = function (regionId) {
    const overlay = document.getElementById('region-form-overlay');
    if (!overlay) return;
    _regionEditingId = regionId || null;
    const title = document.getElementById('region-form-title');
    const name = document.getElementById('region-name');
    const lat = document.getElementById('region-lat');
    const lng = document.getElementById('region-lng');
    const rad = document.getElementById('region-radius-km');
    const en = document.getElementById('region-enabled');
    if (regionId) {
        const r = _regionsCache.find(x => x.id === regionId);
        if (r) {
            title.innerHTML = '<i class="fa-solid fa-pen"></i> Edit region';
            name.value = r.name;
            lat.value = r.center_lat;
            lng.value = r.center_lng;
            rad.value = (r.radius_meters / 1000);
            en.checked = !!r.enabled;
        }
    } else {
        title.innerHTML = '<i class="fa-solid fa-plus"></i> Add region';
        name.value = '';
        lat.value = '';
        lng.value = '';
        rad.value = '10';
        en.checked = false;
    }
    overlay.style.display = 'flex';
};

window.closeRegionForm = function () {
    const overlay = document.getElementById('region-form-overlay');
    if (overlay) overlay.style.display = 'none';
    _regionEditingId = null;
};

window.saveRegionForm = async function () {
    const name = (document.getElementById('region-name').value || '').trim();
    const lat = parseFloat(document.getElementById('region-lat').value);
    const lng = parseFloat(document.getElementById('region-lng').value);
    const radKm = parseFloat(document.getElementById('region-radius-km').value);
    const enabled = document.getElementById('region-enabled').checked;
    if (!name) return showToast('Name required', 'error');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return showToast('Latitude must be -90..90', 'error');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return showToast('Longitude must be -180..180', 'error');
    if (!Number.isFinite(radKm) || radKm < 0.1 || radKm > 200) return showToast('Radius must be 0.1..200 km', 'error');

    const body = {
        name,
        center_lat: lat,
        center_lng: lng,
        radius_meters: Math.round(radKm * 1000),
        enabled,
    };
    const isEdit = !!_regionEditingId;
    const url = isEdit
        ? `${BACKEND_HOST}/api/v1/admin/regions/${_regionEditingId}`
        : `${BACKEND_HOST}/api/v1/admin/regions`;
    const method = isEdit ? 'PATCH' : 'POST';
    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Save failed: ${detail}`, 'error');
        }
        showToast(isEdit ? 'Region updated' : 'Region created', 'success');
        closeRegionForm();
        showRegionsPanel();   // reload list
    } catch (e) {
        showToast(`Save error: ${e.message}`, 'error');
    }
};

window.toggleRegion = async function (regionId) {
    const r = _regionsCache.find(x => x.id === regionId);
    if (!r) return;
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/admin/regions/${regionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !r.enabled }),
        });
        if (!res.ok) return showToast(`Toggle failed (${res.status})`, 'error');
        showToast(r.enabled ? `Disabled "${r.name}"` : `Enabled "${r.name}"`, 'success');
        showRegionsPanel();
    } catch (e) {
        showToast(`Toggle error: ${e.message}`, 'error');
    }
};

window.deleteRegion = async function (regionId) {
    const r = _regionsCache.find(x => x.id === regionId);
    if (!r) return;
    if (!confirm(`Delete region "${r.name}"? Clients in this zone will no longer auto-submit.`)) return;
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/admin/regions/${regionId}`, {
            method: 'DELETE',
        });
        if (res.ok || res.status === 204) {
            showToast(`Deleted "${r.name}"`, 'success');
            showRegionsPanel();
        } else {
            showToast(`Delete failed (${res.status})`, 'error');
        }
    } catch (e) {
        showToast(`Delete error: ${e.message}`, 'error');
    }
};

// P1.8 — admin endpoints now require X-Admin-Key. Cache the key in localStorage
// so the operator only pastes it once. If absent, prompt. If the server later
// returns 403 (key rotated), wipe the cached copy and prompt again.
function _getAdminKey(forcePrompt = false) {
    let key = !forcePrompt ? (localStorage.getItem('crisp_admin_key') || '') : '';
    if (!key) {
        key = prompt(
            'Admin key required for this action.\n\n' +
            '(Set CRISP_ADMIN_KEY on the backend and paste the same value here. ' +
            'It stays in your browser\'s localStorage.)'
        ) || '';
        if (key) localStorage.setItem('crisp_admin_key', key.trim());
    }
    return key.trim();
}

async function _adminFetch(url, init = {}) {
    const key = _getAdminKey();
    if (!key) return null;
    const headers = Object.assign({}, init.headers || {}, { 'X-Admin-Key': key });
    const res = await fetch(url, Object.assign({}, init, { headers }));
    if (res.status === 403) {
        // Cached key is stale/wrong. Clear and try once more.
        localStorage.removeItem('crisp_admin_key');
        const newKey = _getAdminKey(true);
        if (!newKey) return res;
        const retryHeaders = Object.assign({}, init.headers || {}, { 'X-Admin-Key': newKey });
        return fetch(url, Object.assign({}, init, { headers: retryHeaders }));
    }
    return res;
}

window.purgeAllDeletions = async function () {
    if (!confirm(`Permanently delete all ${_pendingDeletions.length} pending deletion(s)? This cannot be undone.`)) return;
    try {
        const res = await _adminFetch(`${API}/purge-all-pending`, { method: 'POST' });
        if (!res) { showToast('Purge cancelled — admin key required', 'error'); return; }
        if (res.ok) {
            const result = await res.json();
            showToast(`${result.purged} report(s) permanently deleted`, 'success');
            // Re-fetch from the server instead of trusting client state — the
            // previous "_pendingDeletions = []" was correct in theory but the
            // counter badge (driven by a separate poll) could have stayed
            // stale if the toggle button rendered from the old cache.
            _pendingDeletions = [];
            await _checkPendingDeletions();
            showPendingDeletions();
            fetchReports();
        } else if (res.status === 503) {
            showToast('Purge disabled: backend is missing CRISP_ADMIN_KEY env var', 'error');
        } else if (res.status === 403) {
            showToast('Purge refused: invalid admin key', 'error');
        } else {
            showToast(`Purge failed (HTTP ${res.status})`, 'error');
        }
    } catch (e) {
        showToast('Purge failed — check connection', 'error');
    }
};

window.purgeExpiredOnly = async function () {
    if (!confirm('Permanently delete all expired deletion requests?')) return;
    try {
        const res = await _adminFetch(`${API}/purge-expired`, { method: 'POST' });
        if (!res) { showToast('Purge cancelled — admin key required', 'error'); return; }
        if (res.ok) {
            const result = await res.json();
            showToast(`Purged ${result.purged} expired report(s)`, 'success');
            _checkPendingDeletions();
            setTimeout(() => showPendingDeletions(), 1000);
            fetchReports();
        } else if (res.status === 503) {
            showToast('Purge disabled: backend is missing CRISP_ADMIN_KEY env var', 'error');
        } else if (res.status === 403) {
            showToast('Purge refused: invalid admin key', 'error');
        } else {
            showToast(`Purge failed (HTTP ${res.status})`, 'error');
        }
    } catch (e) {
        showToast('Purge failed — check connection', 'error');
    }
};

// Check on every poll cycle
const _origFetchReports = fetchReports;

// ── Export Functions ──────────────────────────────────────────────────────────
window.exportData = function (format) {
    // Shapefile and KML use backend API endpoints (binary generation)
    if (format === 'shapefile' || format === 'kml') {
        const base = API.replace('/api/v1/reports', '/api/v1/exports');
        window.open(`${base}/${format === 'shapefile' ? 'shapefile' : 'kml'}`, '_blank');
        showToast(`Downloading ${format.toUpperCase()} export...`, 'success');
        return;
    }
    const filtered = getFilteredReports();
    if (format === 'geojson') exportGeoJSON(filtered);
    else exportCSV(filtered);
};

window.exportNodeData = function (path) {
    const parts = path.split('|');
    let cur = buildControlPanelTree(allReports);
    for (const p of parts) { if (cur && cur[p]) cur = cur[p]; else return; }
    const incs = collectIncidents(cur);
    exportCSV(incs, `crisp_${path.replace(/\|/g, '_')}`);
};

window.exportNodeDataFromIncidents = function (ids) {
    const incs = allReports.filter(r => ids.includes(r.id));
    exportCSV(incs, 'crisp_hotspot');
};

function getFilteredReports() {
    let filtered = allReports.filter(r => {
        if (statusFilter === 'all') return true;
        const s = r.status;
        if (statusFilter === 'active') return s === 'PENDING' || s === 'VERIFIED';
        return s.toLowerCase() === statusFilter.toLowerCase();
    });
    if (timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        filtered = filtered.filter(r => new Date(ensureUTC(r.server_created_at)).getTime() > cutoff);
    }
    return filtered;
}

function exportCSV(reports, filename = 'crisp_export') {
    const headers = ['ID', 'Severity', 'Infrastructure', 'Infrastructure_Name', 'Status', 'Crisis_Type', 'Damage_Classification', 'Debris_Clearing', 'Description', 'Latitude', 'Longitude', 'Time', 'Source', 'Building_ID', 'Country', 'Region'];
    const rows = reports.map(r => [
        r.id, r.severity, r.infrastructure_type, `"${(r.infrastructure_name || '').replace(/"/g, '""')}"`, r.status,
        r.crisis_type || '', r.damage_classification || '', r.debris_clearing_needed ?? '',
        `"${(r.description || '').replace(/"/g, '""')}"`,
        r.location?.latitude || '', r.location?.longitude || '',
        r.server_created_at, r.source, r.building_id || '', r._country || '', r._region || ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadFile(csv, `${filename}.csv`, 'text/csv');
    showToast(`Exported ${reports.length} reports as CSV`, 'success');
}

function exportGeoJSON(reports, filename = 'crisp_export') {
    const features = reports.filter(r => r.location).map(r => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.location.longitude, r.location.latitude] },
        properties: {
            id: r.id, severity: r.severity, infrastructure: r.infrastructure_type,
            infrastructure_name: r.infrastructure_name || '', crisis_type: r.crisis_type || '',
            damage_classification: r.damage_classification || '', debris_clearing: r.debris_clearing_needed ?? '',
            building_id: r.building_id || '',
            status: r.status, description: r.description, time: r.server_created_at,
            source: r.source, country: r._country, region: r._region
        }
    }));
    const geojson = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    downloadFile(geojson, `${filename}.geojson`, 'application/geo+json');
    showToast(`Exported ${features.length} features as GeoJSON`, 'success');
}

function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Priority Zones ───────────────────────────────────────────────────────────
window.togglePriorityZone = function (path) {
    if (priorityZones.has(path)) {
        priorityZones.delete(path);
        showToast('Priority zone removed', 'info');
    } else {
        priorityZones.add(path);
        showToast('Marked as Priority Zone', 'success');
    }
    localStorage.setItem('crisp_priority_zones', JSON.stringify([...priorityZones]));
    renderFeed();
};

// ── State Changers ───────────────────────────────────────────────────────────
window.toggleTreeNode = (p) => { treeState[p] = !treeState[p]; renderFeed(); };

window.setStatusFilter = (f) => {
    statusFilter = f;
    document.querySelectorAll('.stab').forEach(btn => btn.classList.remove('active'));
    const tab = document.getElementById(`stab-${f}`);
    if (tab) tab.classList.add('active');
    renderFeed();
};

window.setTimeFilter = (h) => {
    timeFilterHours = h;
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    renderFeed();
};

// ── Geocoding (Offline-First) ────────────────────────────────────────────────
let worldGeoJSON = null;
// v3.1: Clear old cache format (didn't store individual fields)
const _rawCache = JSON.parse(localStorage.getItem('crisp_geo_cache') || '{}');
const _firstVal = Object.values(_rawCache)[0];
const geoCache = (_firstVal && typeof _firstVal === 'object' && 'city' in _firstVal) ? _rawCache : {};
if (Object.keys(geoCache).length === 0 && Object.keys(_rawCache).length > 0) {
    localStorage.removeItem('crisp_geo_cache');
}

async function loadWorldData() {
    try {
        const res = await fetch('world.json');
        worldGeoJSON = await res.json();
        console.log('World GeoJSON loaded');
    } catch (e) { console.error('Failed to load world.json', e); }
}

function offlineGeocode(lat, lng) {
    if (!worldGeoJSON || !window.turf) return null;
    const pt = turf.point([lng, lat]);
    for (const f of worldGeoJSON.features) {
        if (turf.booleanPointInPolygon(pt, f)) {
            const cc = (f.id || '').toUpperCase();
            const countryName = f.properties.name || 'Unknown Country';
            return {
                country: countryName,
                country_code: cc,
                continent_code: COUNTRY_TO_CONTINENT[cc] || 'Global',
                region_fallback: `${countryName} Strategy Zone`
            };
        }
    }
    return null;
}

async function updateGeodata(reports) {
    let changed = false;
    const pendingGeoRequests = [];

    for (const r of reports) {
        if (!r.location) continue;
        // Skip if already fully geocoded (has a real city/town name)
        if (r._geo_city && r._country && r._continent_code) continue;

        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;

        // 1. Offline geocode (country/continent)
        if (!r._continent_code) {
            const offline = offlineGeocode(lat, lng);
            if (offline) {
                r._country = offline.country;
                r._continent_code = offline.continent_code;
                changed = true;
            }
        }

        // 2. Cache check for detailed geo
        if (geoCache[cacheKey]) {
            const c = geoCache[cacheKey];
            r._geo_city = c.city;
            r._geo_town = c.town;
            r._geo_suburb = c.suburb;
            r._geo_state = c.state;
            r._region = c.city || c.town || c.suburb || c.state || r._region;
            r._country = c.co || r._country;
            r._continent_code = c.cc || r._continent_code;
            changed = true;
        } else if (!r._geo_requested) {
            r._geo_requested = true;
            pendingGeoRequests.push({ r, lat, lng, cacheKey });
        }
    }

    // Fire background geo requests (rate-limited, 1 per second)
    for (let i = 0; i < pendingGeoRequests.length; i++) {
        const { r, lat, lng, cacheKey } = pendingGeoRequests[i];
        // Stagger requests to avoid rate limits
        setTimeout(() => {
            reverseGeocode(r, lat, lng, cacheKey);
        }, i * 1100);
    }

    // Apply 15km spatial clustering for region grouping
    applyRegionClustering(reports);

    if (changed) renderFeed();
}

async function reverseGeocode(r, lat, lng, cacheKey) {
    try {
        const res = await fetch(`https://geocode.maps.co/reverse?lat=${lat}&lon=${lng}&format=json`, { mode: 'cors' });
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                applyGeoResult(r, data.address, cacheKey);
                return;
            }
        }
    } catch (e) {}

    // Fallback to nominatim
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`, { headers: { 'User-Agent': 'CRISP' } });
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                applyGeoResult(r, data.address, cacheKey);
            }
        }
    } catch (e) {}
}

function applyGeoResult(r, address, cacheKey) {
    const a = address;
    const city = a.city || null;
    const town = a.town || null;
    const village = a.village || null;
    const suburb = a.suburb || null;
    const state = a.state || null;
    const cc = (a.country_code || '').toUpperCase();
    const iso3 = ISO2_TO_ISO3[cc] || cc;
    const continent = COUNTRY_TO_CONTINENT[iso3] || COUNTRY_TO_CONTINENT[cc] || r._continent_code || 'Global';

    // Store individual fields for clustering to use
    r._geo_city = city || town || village;
    r._geo_town = town || village;
    r._geo_suburb = suburb;
    r._geo_state = state;
    r._country = a.country || r._country;
    r._continent_code = continent;

    // Set region to best available name
    const regionName = city || town || village || suburb || state;
    if (regionName) r._region = regionName;

    // Cache with individual fields
    geoCache[cacheKey] = {
        city: city || town || village,
        town: town || village,
        suburb,
        state,
        co: a.country,
        cc: continent
    };
    localStorage.setItem('crisp_geo_cache', JSON.stringify(geoCache));

    // Re-cluster and re-render
    applyRegionClustering(allReports);
    renderFeed();
}

// ── Data Fetching ────────────────────────────────────────────────────────────
const REPORTS_CACHE_KEY = 'crisp_reports_v1';

function _applyReportData(data) {
    let detailPanelNeedsRefresh = false;
    data.forEach(r => {
        if (!knownIds.has(r.id)) {
            knownIds.add(r.id);
            allReports.push(r);
            // Live notification ONLY for genuinely new incidents (not initial page load)
            if (_initialLoadDone && !_seenIds.has(r.id)) {
                _addNotification(r);
            } else {
                // Initial load — silently mark as seen, no flash
                _seenIds.add(r.id);
            }
        } else {
            const idx = allReports.findIndex(x => x.id === r.id);
            if (idx >= 0) {
                const geo = { _region: allReports[idx]._region, _country: allReports[idx]._country, _continent_code: allReports[idx]._continent_code };
                const prev = allReports[idx];
                allReports[idx] = { ...r, ...geo };
                if (r.id === selectedId) {
                    const prevImg = prev.media?.find(m => m.type === 'IMAGE');
                    const newImg  = r.media?.find(m => m.type === 'IMAGE');
                    if (newImg && (
                        !prevImg ||
                        prevImg.thumbnail_url    !== newImg.thumbnail_url   ||
                        prevImg.completion_pct   !== newImg.completion_pct  ||
                        prevImg.assembly_status  !== newImg.assembly_status
                    )) detailPanelNeedsRefresh = true;
                    // Audio progressive refresh
                    const prevAud = prev.media?.find(m => m.type === 'AUDIO');
                    const newAud  = r.media?.find(m => m.type === 'AUDIO');
                    if (newAud && (
                        !prevAud ||
                        prevAud.thumbnail_url    !== newAud.thumbnail_url   ||
                        prevAud.completion_pct   !== newAud.completion_pct  ||
                        prevAud.assembly_status  !== newAud.assembly_status
                    )) detailPanelNeedsRefresh = true;
                    if (prev.sync_status !== r.sync_status) detailPanelNeedsRefresh = true;
                }
            }
        }
    });
    updateGeodata(allReports);
    updateMapMarkers();
    renderFeed();
    if (detailPanelNeedsRefresh && selectedId) selectReport(selectedId, true);
    // Guaranteed-delivery: after the feed/map update, check whether any
    // currently-rendered photo group now has a BETTER variant available than
    // the one shown (SMALL → MEDIUM → LARGE). If so, hot-swap the <img src>
    // in-place so analysts see the upgrade without a full panel rebuild.
    _maybeUpgradeDetailImage();
}

// ── Progressive image upgrade on poll ─────────────────────────────────────
// Looks at every .dp-img[data-group-id] and .dp-gallery-thumb[data-group-id]
// in the open detail panel and swaps their <img src> if bestVariant(group)
// now resolves to a higher-tier complete variant than the one rendered.
// Zero-cost when no upgrade is available.
function _maybeUpgradeDetailImage() {
    if (!selectedId) return;
    // Phase 2: respect manual tier override — don't auto-upgrade when the
    // user has deliberately picked a tier. `setDetailImageTier` stamps the
    // override; `closeDetail` and report-delete clear it.
    if (_tierOverride.has(selectedId)) return;
    const r = allReports.find(x => x.id === selectedId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    if (!images.length) return;
    const groups = groupPhotos(images);
    // Build a groupId → pick lookup. Null-group entries are skipped — the
    // legacy single-media path never upgrades.
    const groupMap = new Map();
    for (const g of groups) {
        if (!g.group_id) continue;
        const pick = bestVariant(g);
        if (pick) groupMap.set(g.group_id, pick);
    }
    if (groupMap.size === 0) return;

    // Main image (primary photo)
    document.querySelectorAll(`#dp-img-view-${selectedId} .dp-img[data-group-id]`).forEach(el => {
        const gid = el.getAttribute('data-group-id');
        const pick = groupMap.get(gid);
        if (!pick || !pick.isFinal) return;
        const currentTier = el.getAttribute('data-current-tier');
        if (currentTier === pick.tier) return;   // already showing this variant
        const img = el.querySelector('img');
        if (img && img.src !== pick.src) {
            img.src = pick.src;
            img.classList.remove('img-thumb-bg');
            img.classList.add('img-full-layer', 'img-ready');
        }
        el.setAttribute('data-current-tier', pick.tier);
        el.classList.remove('dp-img-uploading');
        // Phase 2: sync tier-switcher active button + enable any tier that
        // has now finished assembly since the last render.
        const switcher = el.querySelector('.dp-tier-switcher');
        if (switcher) {
            switcher.querySelectorAll('.dp-tier-btn').forEach(b => {
                b.classList.remove('active');
                // Re-enable buttons whose tier is now complete.
                const tierClass = [...b.classList].find(c => c.startsWith('dp-tier-') && c !== 'dp-tier-btn');
                const tier = tierClass ? tierClass.replace('dp-tier-', '').toUpperCase() : null;
                if (tier) {
                    const g = groups.find(gg => gg.group_id === gid);
                    const m = g && g.members.find(mm => mm.resolution_tier === tier && mm.assembly_status === 'complete' && mm.url);
                    if (m) b.classList.remove('disabled');
                }
            });
            const activeBtn = switcher.querySelector(`.dp-tier-btn.dp-tier-${pick.tier.toLowerCase()}`);
            if (activeBtn) activeBtn.classList.add('active');
        }
        // Refresh the onclick handler so the lightbox opens the upgraded image
        el.setAttribute('onclick', `openLightbox('${pick.src}','${(r.infrastructure_type || 'Photo')}')`);
    });

    // Gallery strip thumbs (for reports with multiple photos)
    document.querySelectorAll(`#dp-img-view-${selectedId} ~ .dp-gallery .dp-gallery-thumb[data-group-id]`).forEach(el => {
        const gid = el.getAttribute('data-group-id');
        const pick = groupMap.get(gid);
        if (!pick) return;
        const currentTier = el.getAttribute('data-current-tier');
        if (currentTier === pick.tier) return;
        const img = el.querySelector('img');
        if (img && img.src !== pick.src) img.src = pick.src;
        el.setAttribute('data-current-tier', pick.tier);
        // Remove the % badge once the variant is final
        if (pick.isFinal) {
            const pctEl = el.querySelector('.dp-gallery-pct');
            if (pctEl) pctEl.remove();
        }
    });
}

// ── Testability + debug hooks ─────────────────────────────────────────────
// Apr 2026: expose read-only pointers to the module-scope state + the
// poll function so the Playwright E2E suite and ad-hoc DevTools debugging
// can inspect and kick the report list without a 4-second wait.
// NOT used by production code paths — safe to keep always-on.
Object.defineProperty(window, 'allReports', {
    get: () => allReports,
    configurable: true,
});
// Leaflet instances so the map-render spec can walk clusterGroup's layers
// without screen-scraping Leaflet's private DOM. Read-only getters —
// production code never mutates these via `window.*`.
Object.defineProperty(window, '__crispMap', {
    get: () => map,
    configurable: true,
});
Object.defineProperty(window, '__crispClusterGroup', {
    get: () => clusterGroup,
    configurable: true,
});
// Filter-state mirror for the filter spec.
Object.defineProperty(window, '__crispActivePillFilter', {
    get: () => _activePillFilter,
    configurable: true,
});
Object.defineProperty(window, '__crispTimeFilterHours', {
    get: () => timeFilterHours,
    configurable: true,
});
window.__crispFetchReports = () => fetchReports();

async function fetchReports() {
    try {
        const listUrl = API.endsWith('/') ? API : API + '/';
        console.log('[CRISP] Fetching from:', listUrl);
        const res  = await fetch(listUrl);
        console.log('[CRISP] Response:', res.status, res.url);
        const data = await res.json();
        console.log('[CRISP] Loaded', data.length, 'reports');
        try {
            localStorage.setItem(REPORTS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch (_) {}
        _updateCacheBadge(false);
        // Apply rendering separately so UI errors don't look like network failures
        try {
            _applyReportData(data);
            if (!_initialLoadDone) {
                _initialLoadDone = true;
                try { localStorage.setItem('crisp_seen_ids', JSON.stringify([..._seenIds])); } catch(_){}
                console.log('[CRISP] Initial load complete — future reports will trigger notifications');
            }
            console.log('[CRISP] Rendered', allReports.length, 'reports on map');
        } catch (e) {
            console.error('[CRISP] RENDER ERROR:', e);
            // Show error visually so user can report it
            const feed = document.getElementById('report-feed-list');
            if (feed) feed.innerHTML = `<div style="padding:20px;color:#ef4444;font-size:13px;"><b>Render Error:</b> ${e.message}<br><br>Data loaded (${data.length} reports) but UI failed. Check console (Cmd+Option+J).</div>`;
        }
        _checkPendingDeletions();
    } catch (e) {
        console.error('[CRISP] FETCH ERROR:', e);
        _updateCacheBadge(true);
        const feed = document.getElementById('report-feed-list');
        if (feed && !allReports.length) feed.innerHTML = `<div style="padding:20px;color:#f59e0b;font-size:13px;"><b>Connection Error:</b> ${e.message}<br><br>API: ${API}<br>Check if backend is running on port 8000.</div>`;
    }
    _reschedulePoller();
}

function _hasActiveUploads() {
    return allReports.some(r => {
        return r.media?.some(m =>
            (m.type === 'IMAGE' || m.type === 'AUDIO') &&
            m.assembly_status !== 'complete' &&
            (m.completion_pct ?? 0) > 0
        );
    });
}

function _reschedulePoller() {
    if (_pollTimer) clearTimeout(_pollTimer);
    const interval = _hasActiveUploads() ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL;
    _pollTimer = setTimeout(fetchReports, interval);
}

function _updateCacheBadge(stale) {
    const badge = document.getElementById('cache-freshness-badge');
    // Apr 2026 fix: the bottom "Offline — showing cached data" banner used
    // to be driven by navigator.onLine (unreliable: gets stuck false after
    // transient network hiccups). Now it tracks ACTUAL fetch results via
    // the bridge `window.setDashboardOnline(ok)` defined in index.html.
    try {
        if (typeof window.setDashboardOnline === 'function') {
            window.setDashboardOnline(!stale);
        }
    } catch (_) { /* never let banner logic break data rendering */ }

    if (!badge) return;
    if (stale) {
        badge.innerHTML = '<span class="live-dot" style="background:#f59e0b;box-shadow:0 0 6px #f59e0b;"></span>CACHED';
        badge.title = 'Showing cached data — reconnect to refresh';
        badge.style.borderColor = 'rgba(245,158,11,0.4)';
    } else {
        badge.innerHTML = '<span class="live-dot"></span>LIVE';
        badge.title = 'Data is live from server';
        badge.style.borderColor = '';
    }
}

function _loadCachedReports() {
    try {
        const raw = localStorage.getItem(REPORTS_CACHE_KEY);
        if (!raw) return false;
        const { ts, data } = JSON.parse(raw);
        if (!Array.isArray(data) || !data.length) return false;
        _applyReportData(data);
        // Show age of cache
        const ageMin = Math.round((Date.now() - ts) / 60000);
        const badge = document.getElementById('cache-freshness-badge');
        if (badge) {
            badge.textContent = `⚠ Cached ${ageMin}m ago`;
            badge.style.color = '#f59e0b';
        }
        return true;
    } catch (_) { return false; }
}

// ── Init ─────────────────────────────────────────────────────────────────────
// ── Auth: Logout + User Menu ─────────────────────────────────────────────────
window.crispLogout = async () => {
    try { await fetch(`${BACKEND_HOST}/api/v1/auth/logout`, { method: 'POST' }); } catch (_) {}
    localStorage.removeItem('crisp_token');
    localStorage.removeItem('crisp_refresh');
    localStorage.removeItem('crisp_user');
    window.location.href = 'login.html';
};

function _initUserMenu() {
    const u = _crispUser;
    if (!u) return;
    const nameEl = document.getElementById('user-name-display');
    const roleEl = document.getElementById('user-role-badge');
    if (nameEl) nameEl.textContent = u.full_name || u.email?.split('@')[0] || '';
    if (roleEl) roleEl.textContent = u.role || 'VIEWER';
    // Phase 4: reveal Regions button only to admins.
    if (typeof _maybeShowRegionsButton === 'function') _maybeShowRegionsButton();
}

// ── Token auto-refresh (5 min before expiry) ─────────────────────────────────
async function _autoRefreshToken() {
    const refresh = localStorage.getItem('crisp_refresh');
    if (!refresh) return;
    try {
        const res = await _origFetch(`${BACKEND_HOST}/api/v1/auth/refresh`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refresh }),
        });
        if (res.ok) {
            const data = await res.json();
            localStorage.setItem('crisp_token', data.access_token);
        }
    } catch (_) {}
}
setInterval(_autoRefreshToken, 25 * 60 * 1000); // Refresh every 25 min

document.addEventListener('DOMContentLoaded', async () => {
    _initUserMenu();
    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
        document.querySelectorAll('.export-dropdown.open, .sort-dropdown.open').forEach(d => {
            if (!d.contains(e.target)) d.classList.remove('open');
        });
    });
    initMap();
    await loadWorldData();

    // Show loading state in feed while data loads
    const feedList = document.getElementById('report-feed-list');
    if (feedList && !allReports.length) {
        feedList.innerHTML = `<div class="feed-empty-state">
            <i class="fa-solid fa-spinner fa-spin" style="color:var(--info);"></i>
            <div class="feed-empty-title">Connecting to server...</div>
            <div class="feed-empty-sub">Loading incident reports</div>
        </div>`;
    }

    // Show cached data instantly (zero network needed)
    _loadCachedReports();

    // Fetch fresh data, then adaptive polling takes over
    fetchReports();
});
