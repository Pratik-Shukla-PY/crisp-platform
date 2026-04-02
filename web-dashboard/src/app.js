// ══════════════════════════════════════════════════════════════════════════════
// CRISP — Crisis Intelligence Control Panel  v3.0
// Hierarchical, decision-focused, scalable dashboard for UN crisis response
// ══════════════════════════════════════════════════════════════════════════════

// ── Config ───────────────────────────────────────────────────────────────────
const BACKEND_HOST = `http://${window.location.hostname || 'localhost'}:8000`;
const API = `${BACKEND_HOST}/api/v1/reports`;
const POLL_INTERVAL        = 4000;  // normal polling
const POLL_INTERVAL_ACTIVE = 1200;  // fast polling while any image is uploading
let _pollTimer = null;

// ── State ────────────────────────────────────────────────────────────────────
let allReports = [];
let sortMode = 'impact';
let timeFilterHours = 24;
let statusFilter = 'active';
let selectedId = null;
const knownIds = new Set();
const liveMarkers = {};
let firstZoomDone = false;
let heatLayer = null;
let clusterGroup = null;
let boundaryLayers = [];
let currentAudio = null;
let treeState = {};
let priorityZones = new Set(JSON.parse(localStorage.getItem('crisp_priority_zones') || '[]'));

const SEV_SCORE = { CRITICAL: 10, SEVERE: 7, MODERATE: 4, MINOR: 2, UNKNOWN: 1 };
const INFRA_WEIGHTS = { HOSPITAL: 10, POWER_PLANT: 8, POWER: 8, WATER_TREATMENT: 7, WATER: 7, ROAD: 3, BRIDGE: 5, SCHOOL: 4, HOUSE: 2, OTHER: 1 };
const INFRA_ICONS = { HOSPITAL: 'fa-hospital', POWER: 'fa-bolt', WATER: 'fa-droplet', ROAD: 'fa-road', HOUSE: 'fa-house-crack', OTHER: 'fa-triangle-exclamation' };
const SEV_COLORS = { CRITICAL: '#ef4444', SEVERE: '#f97316', MODERATE: '#eab308', MINOR: '#22c55e', UNKNOWN: '#64748b' };

// ── QRT Queue State ───────────────────────────────────────────────────────────
let viewMode = 'queue'; // 'queue' = triage cards | 'tree' = strategic hierarchy
let sectionState = { needs: true, dispatched: false, resolved: false };
// Priority sort: severity first, then infrastructure criticality, then recency
const SEV_PRIORITY = { CRITICAL: 4, SEVERE: 3, MODERATE: 2, MINOR: 1, UNKNOWN: 0 };
const INFRA_CARD_ICONS = {
    HOSPITAL: 'fa-hospital', POWER_PLANT: 'fa-bolt', POWER: 'fa-bolt',
    WATER_TREATMENT: 'fa-droplet', WATER: 'fa-droplet', ROAD: 'fa-road',
    BRIDGE: 'fa-archway', SCHOOL: 'fa-school', HOUSE: 'fa-house-crack',
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
        const t = new Date(r.server_created_at).getTime();
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
    const tree = {};
    reports.forEach(r => {
        const cont = CONTINENT_NAMES[r._continent_code] || 'Global';
        const coun = r._country || 'Unknown Country';
        const reg = r._region || 'Unknown Region';
        const type = r.infrastructure_type || 'OTHER';
        const sev = r.severity || 'UNKNOWN';
        const st = r.status || 'PENDING';

        if (!tree[cont]) tree[cont] = {};
        if (!tree[cont][coun]) tree[cont][coun] = {};
        if (!tree[cont][coun][reg]) tree[cont][coun][reg] = {};
        if (!tree[cont][coun][reg][type]) tree[cont][coun][reg][type] = {};
        if (!tree[cont][coun][reg][type][sev]) tree[cont][coun][reg][type][sev] = {};
        if (!tree[cont][coun][reg][type][sev][st]) tree[cont][coun][reg][type][sev][st] = [];
        tree[cont][coun][reg][type][sev][st].push(r);
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

    div.innerHTML = `
        <span class="chevron" title="Expand/Collapse"><i class="fa-solid fa-chevron-right"></i></span>
        ${getLevelIcon(levelName, label)}
        <span class="tree-label">${label}</span>
        ${isPriority ? '<span class="priority-flag" title="Priority Zone"><i class="fa-solid fa-flag"></i></span>' : ''}
        ${metricsHTML(stats, useCompact)}
        ${quickActionsHTML(path, levelName)}
    `;

    div.onclick = (e) => {
        e.stopPropagation();
        toggleTreeNode(path);
        focusMapOnNode(path);
    };
    return div;
}

function renderTreeLevel(parentEl, data, levelIndex, currentPath) {
    const levels = ['continent', 'country', 'region', 'type', 'severity', 'status'];
    const levelName = levels[levelIndex];
    if (!levelName) return;

    const keys = sortNodes(Object.keys(data), data);

    keys.forEach(key => {
        const path = currentPath ? `${currentPath}|${key}` : key;
        // Default: expand continent & country, collapse deeper levels
        if (treeState[path] === undefined) {
            treeState[path] = levelIndex <= 1;
        }
        const expanded = !!treeState[path];
        const stats = calculateNodeMetrics(data[key]);

        const node = document.createElement('div');
        node.className = `tree-node level-${levelName} ${priorityZones.has(path) ? 'priority-zone' : ''}`;
        node.appendChild(createTreeHeader(key, stats, levelName, path, expanded));

        if (expanded) {
            const content = document.createElement('div');
            content.className = 'tree-content';

            if (levelIndex < levels.length - 1) {
                renderTreeLevel(content, data[key], levelIndex + 1, path);
            } else {
                // Leaf level: render incidents
                const incidents = data[key];
                incidents.forEach(r => {
                    content.appendChild(createIncidentRow(r));
                });
            }
            node.appendChild(content);
        }
        parentEl.appendChild(node);
    });
}

function createIncidentRow(r) {
    const inc = document.createElement('div');
    inc.className = `tree-incident ${selectedId === r.id ? 'selected' : ''}`;
    inc.onclick = (e) => { e.stopPropagation(); selectReport(r.id); };

    const desc = (r.description || 'No description').substring(0, 40);
    const hasImg = r.media?.some(m => m.type === 'IMAGE');
    const hasAudio = r.media?.some(m => m.type === 'AUDIO');
    const isPartial = r.sync_status === 'PARTIAL';
    // W-6 fix: use chunk-level completion_pct from media if available,
    // otherwise fall back to assembled-file ratio (which only shows 0% or 100%)
    const imgMedia = r.media?.find(m => m.type === 'IMAGE');
    const pctDone = imgMedia?.completion_pct != null
        ? Math.round(imgMedia.completion_pct)
        : (r.expected_media > 0 ? Math.round((r.received_media / r.expected_media) * 100) : 100);

    inc.innerHTML = `
        <span class="inc-sev-dot sev-dot-${r.severity}" title="Severity: ${r.severity}"></span>
        <span class="inc-type" title="Infrastructure type">${r.infrastructure_type}</span>
        <span class="inc-desc" title="${(r.description || 'No description').replace(/"/g, '&quot;')}">${desc}</span>
        <span class="inc-media-icons">
            ${hasImg ? '<i class="fa-solid fa-image" title="Has photo"></i>' : (r.expected_media > 0 && !hasImg ? '<i class="fa-solid fa-image" title="Photo pending" style="opacity:0.3;"></i>' : '')}
            ${hasAudio ? '<i class="fa-solid fa-microphone" title="Has audio"></i>' : (r.expected_media > 0 && !hasAudio ? '<i class="fa-solid fa-microphone" title="Audio pending" style="opacity:0.3;"></i>' : '')}
            ${isPartial ? `<span class="sync-partial-badge" title="Data: ${pctDone}% received (${r.received_media}/${r.expected_media} files)">${pctDone}%</span>` : ''}
            ${r.is_auto_submitted ? '<i class="fa-solid fa-hourglass-end" title="Auto-submitted" style="color: #ff9800; font-size: 0.75rem;"></i>' : ''}
        </span>
        <span class="inc-time">${timeAgo(r.server_created_at)}</span>
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
}

// ── Queue Mode: three-bucket triage cards ─────────────────────────────────────
function renderTriageQueue(el) {
    // Apply time filter
    let reports = allReports;
    if (timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        reports = reports.filter(r => new Date(r.server_created_at).getTime() > cutoff);
    }

    // Three buckets by action status
    const needs      = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    const dispatched = reports.filter(r => r.status === 'RESPONDING');
    const resolved   = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');

    // Sort each bucket: severity → infra weight → recency
    [needs, dispatched, resolved].forEach(bucket => bucket.sort(sortByPriorityDesc));

    el.innerHTML = '';
    const frag = document.createDocumentFragment();

    // Flashing alert if critical incidents are still waiting for response
    const criticals = needs.filter(r => r.severity === 'CRITICAL');
    if (criticals.length > 0) frag.appendChild(createAlertBanner(criticals.length));

    // Three collapsible sections
    frag.appendChild(createQueueSection('needs',      '⚡ NEEDS RESPONSE', needs,      'qrt-section-needs'));
    frag.appendChild(createQueueSection('dispatched', '🚑 DISPATCHED',     dispatched, 'qrt-section-dispatched'));
    frag.appendChild(createQueueSection('resolved',   '✓  RESOLVED',       resolved,   'qrt-section-resolved'));

    el.appendChild(frag);
    document.getElementById('feed-count-badge').textContent =
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
            <i class="fa-solid fa-truck-medical"></i> DISPATCH
        </button>`;
    } else if (r.status === 'RESPONDING') {
        actionEl = `<span class="qrt-dispatched-label"><i class="fa-solid fa-siren-on"></i> En Route</span>`;
    } else {
        actionEl = `<span class="qrt-resolved-label"><i class="fa-solid fa-circle-check"></i> Done</span>`;
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
        const icon = score >= 60 ? 'fa-satellite' : 'fa-triangle-exclamation';
        truthBadge = `<span class="qrt-truth-badge ${badgeClass}" title="${verdict.replace(/_/g,' ')}">
            <i class="fa-solid ${icon}"></i> ${score}
        </span>`;
    }

    card.innerHTML = `
        <div class="qrt-sev-strip strip-${sev}"></div>
        <div class="qrt-card-body">
            <div class="qrt-what">
                <div class="qrt-infra-icon"><i class="fa-solid ${icon}"></i></div>
                <span class="qrt-infra-name">${infra.replace(/_/g, ' ')}</span>
                <span class="qrt-sev-badge qrt-sev-${sev}">${sev}</span>
            </div>
            <div class="qrt-where">
                <i class="fa-solid fa-location-dot"></i>
                <span class="qrt-where-text" title="${locText}">${locText}</span>
            </div>
            <div class="qrt-when">
                <i class="fa-regular fa-clock"></i>
                ${timeAgo(r.server_created_at)}
            </div>
            <div class="qrt-data-progress">
                <span class="qrt-dp-item ${locDone ? 'done' : ''}" title="Location">
                    <i class="fa-solid ${locDone ? 'fa-check' : 'fa-location-dot'}"></i> Loc
                </span>
                <span class="qrt-dp-item ${imgDone ? 'done' : hasImg ? 'active' : 'waiting'}" title="Image: ${Math.round(imgPct)}%">
                    <i class="fa-solid ${imgDone ? 'fa-check' : hasImg ? 'fa-cloud-arrow-up' : 'fa-image'}"></i>
                    ${imgDone ? 'Img' : hasImg && !imgDone ? Math.round(imgPct) + '%' : 'Img'}
                </span>
                <span class="qrt-dp-item ${audioDone ? 'done' : hasAudio ? 'active' : 'waiting'}" title="Audio: ${Math.round(audioPct)}%">
                    <i class="fa-solid ${audioDone ? 'fa-check' : hasAudio ? 'fa-cloud-arrow-up' : 'fa-microphone'}"></i>
                    ${audioDone ? 'Aud' : hasAudio && !audioDone ? Math.round(audioPct) + '%' : 'Aud'}
                </span>
                ${allDone ? '<span class="qrt-dp-all-done"><i class="fa-solid fa-circle-check"></i> 100%</span>' : ''}
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
    // Show/hide tree-specific controls (sort + status tabs)
    const tc = document.getElementById('tree-controls');
    if (tc) tc.style.display = mode === 'tree' ? '' : 'none';
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
        filtered = filtered.filter(r => new Date(r.server_created_at).getTime() > cutoff);
    }
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    renderHotspots(frag, filtered);
    const tree = buildControlPanelTree(filtered);
    renderTreeLevel(frag, tree, 0, '');
    el.appendChild(frag);
    document.getElementById('feed-count-badge').textContent = `${filtered.length} Active`;
    // Update status tab highlights
    document.querySelectorAll('.stab').forEach(btn => btn.classList.remove('active'));
    const activeTab = document.getElementById(`stab-${statusFilter}`);
    if (activeTab) activeTab.classList.add('active');
}

function updateCommandStats() {
    let critical = 0, responding = 0, resolved = 0;
    allReports.forEach(r => {
        if (r.severity === 'CRITICAL' || r.severity === 'SEVERE') critical++;
        if (r.status === 'RESPONDING') responding++;
        if (r.status === 'RESOLVED') resolved++;
    });
    document.getElementById('count-critical').textContent = critical;
    document.getElementById('count-responding').textContent = responding;
    document.getElementById('count-resolved').textContent = resolved;
    document.getElementById('count-total').textContent = allReports.length;
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

    // W-4 fix: img.url is '' before assembly completes — fall back to thumbnail_url
    const thumbUrl = img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) : '';
    const fullUrl  = img?.url && img.assembly_status === 'complete' ? getMediaUrl(img.url) : '';
    p.innerHTML = `
        ${thumbUrl || fullUrl ? `
        <div class="fp-img-wrap">
            ${thumbUrl ? `<img src="${thumbUrl}" class="fp-img fp-img-blur" alt="">` : ''}
            ${fullUrl  ? `<img src="${fullUrl}"  class="fp-img fp-img-full" alt="Incident photo"
                              onload="this.classList.add('img-ready')" onerror="this.style.display='none'">` : ''}
        </div>` : ''}
        <div class="fp-main">
            <div class="fp-title">${r.infrastructure_type} <span class="fp-sev sev-dot-${r.severity}">${r.severity}</span></div>
            <div class="fp-desc">${r.description || 'No description'}</div>
            ${ai?.transcription ? `<div class="fp-transcript"><i class="fa-solid fa-quote-left"></i> ${ai.transcription.substring(0, 80)}...</div>` : ''}
            ${loc ? `<div class="fp-loc"><i class="fa-solid fa-location-dot"></i> ${loc.user_location_name || loc.device_location_name || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`}</div>` : ''}
            ${audio ? `<button class="fp-audio-btn" onclick="event.stopPropagation(); playPreviewAudio('${getMediaUrl(audio.url)}', this)"><i class="fa-solid fa-play"></i> Play Audio</button>` : ''}
            <div class="fp-meta">${timeAgo(r.server_created_at)} · ${r.status}</div>
        </div>
    `;

    // Position near cursor but within viewport
    const rect = event.target.getBoundingClientRect();
    const panelLeft = rect.right + 12;
    const maxLeft = window.innerWidth - 320;
    p.style.left = `${Math.min(panelLeft, maxLeft)}px`;
    p.style.top = `${Math.max(rect.top - 20, 10)}px`;
    p.style.display = 'flex';
}

function hideIncidentPreview() {
    const p = document.getElementById('fast-preview');
    if (p) p.style.display = 'none';
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

    const img   = r.media?.find(m => m.type === 'IMAGE');
    const audio = r.media?.find(m => m.type === 'AUDIO');
    const loc   = r.location;
    const ai    = r.ai_analysis;
    const v     = r.verification;
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const infraIcon = INFRA_ICONS[r.infrastructure_type] || 'fa-triangle-exclamation';
    const locName = loc?.user_location_name || loc?.device_location_name || null;
    const locLat  = loc?.latitude;
    const locLng  = loc?.longitude;

    // ── Image HTML (compact 160px) ──
    const imgPct = (img?.completion_pct ?? 0);
    const imgComplete = img?.assembly_status === 'complete' && img?.url;
    const imgSrc = imgComplete ? getMediaUrl(img.url) : (img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) + '?_cb=' + (Math.round(imgPct/5)*5) : '');
    const imgHtml = img ? (
        imgComplete
            ? `<div class="dp-img" onclick="openLightbox('${getMediaUrl(img.url)}','${r.infrastructure_type}')">
                   ${img.thumbnail_url ? `<img src="${getMediaUrl(img.thumbnail_url)}" class="img-thumb-bg">` : ''}
                   <img src="${getMediaUrl(img.url)}" class="img-full-layer" onload="this.classList.add('img-ready')" onerror="this.style.display='none'">
               </div>`
            : imgSrc
                ? `<div class="dp-img dp-img-uploading">
                       <img src="${imgSrc}" class="img-thumb-bg">
                       <div class="img-progress-overlay">
                           <div class="chunk-progress-track"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div>
                           <span class="partial-img-label"><i class="fa-solid fa-cloud-arrow-up fa-pulse"></i> ${imgPct.toFixed(0)}%</span>
                       </div>
                   </div>`
                : imgPct > 0
                    ? `<div class="dp-img dp-img-placeholder"><div class="chunk-progress-track" style="width:80%"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div><span style="font-size:9px;color:#6b7280;">${imgPct.toFixed(0)}%</span></div>`
                    : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera" style="font-size:18px;color:#334155;"></i></div>`
    ) : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera-slash" style="font-size:16px;color:#334155;"></i></div>`;

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
        : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-satellite" style="font-size:16px;color:#334155;"></i><span style="font-size:8px;color:#475569;">Not verified</span></div>`;

    // ── Audio HTML (compact inline strip) ──
    const aPct = (audio?.completion_pct ?? 0);
    const aComplete = audio?.assembly_status === 'complete' && audio?.url;
    const aPartialUrl = audio?.thumbnail_url ? getMediaUrl(audio.thumbnail_url) + '?_cb=' + (Math.round(aPct/5)*5) : '';
    const audioPlayUrl = aComplete ? getMediaUrl(audio.url) : aPartialUrl;

    // ── Verification inline + full report ──
    const vGaugeHtml = (() => {
        if (!v) return '';
        const total = v.total_score || 0;
        const C = 125.66;
        const offset = C - (total / 100) * C;
        const gc = total >= 80 ? '#22c55e' : total >= 60 ? '#86efac' : total >= 40 ? '#eab308' : total >= 20 ? '#f97316' : '#ef4444';
        const verdictLabels = { STRONGLY_CORROBORATED:'Corroborated', LIKELY_AUTHENTIC:'Likely Authentic', PARTIALLY_VERIFIED:'Partial', LOW_CONFIDENCE:'Low Confidence', UNVERIFIED:'Unverified' };
        const vLabel = verdictLabels[v.verdict] || v.verdict || '';
        const scores = v.scores || {};
        const barPct = (val) => Math.round(((val || 0) / 25) * 100);
        const barCol = (val) => val >= 20 ? '#22c55e' : val >= 13 ? '#eab308' : '#ef4444';
        const findings = (v.key_findings || []).map(f => `<div style="font-size:9px;color:var(--text-sub);margin-bottom:3px;"><i class="fa-solid fa-circle-dot" style="color:var(--info);font-size:6px;margin-right:4px;"></i>${f}</div>`).join('');
        const caveats = (v.caveats || []).map(c => `<div style="font-size:9px;color:#fbbf24;margin-bottom:3px;"><i class="fa-solid fa-triangle-exclamation" style="font-size:6px;margin-right:4px;"></i>${c}</div>`).join('');
        return `
        <div class="dp-verify-strip" onclick="document.getElementById('dp-full-report').style.display=document.getElementById('dp-full-report').style.display==='none'?'block':'none'" style="cursor:pointer;">
            <div class="dp-gauge">
                <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
                <circle cx="22" cy="22" r="18" fill="none" stroke="${gc}" stroke-width="5" stroke-linecap="round"
                    stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" transform="rotate(-90 22 22)"/></svg>
                <span class="dp-gauge-num" style="color:${gc};">${total}</span>
            </div>
            <div class="dp-verify-info">
                <div class="dp-verdict" style="color:${gc};">${vLabel}</div>
                <div class="dp-verify-desc">${v.satellite_scene_description ? v.satellite_scene_description.substring(0, 100) + '...' : 'Click for full report'}</div>
            </div>
            <i class="fa-solid fa-chevron-down" style="color:var(--text-dim);font-size:9px;"></i>
        </div>
        <div id="dp-full-report" style="display:none;padding:8px 10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:8px;margin-bottom:8px;margin-top:-4px;">
            ${v.error ? `<div style="padding:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font-size:10px;color:#fca5a5;margin-bottom:8px;"><i class="fa-solid fa-triangle-exclamation"></i> ${v.error}</div>` : ''}
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:6px;font-size:9px;"><span style="width:90px;color:var(--text-dim);flex-shrink:0;">Location</span><div style="flex:1;height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${barPct(scores.location_authenticity)}%;background:${barCol(scores.location_authenticity)};border-radius:2px;"></div></div><span style="color:var(--text-sub);">${scores.location_authenticity ?? '—'}/25</span></div>
                <div style="display:flex;align-items:center;gap:6px;font-size:9px;"><span style="width:90px;color:var(--text-dim);flex-shrink:0;">Damage</span><div style="flex:1;height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${barPct(scores.damage_corroboration)}%;background:${barCol(scores.damage_corroboration)};border-radius:2px;"></div></div><span style="color:var(--text-sub);">${scores.damage_corroboration ?? '—'}/25</span></div>
                <div style="display:flex;align-items:center;gap:6px;font-size:9px;"><span style="width:90px;color:var(--text-dim);flex-shrink:0;">Description</span><div style="flex:1;height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${barPct(scores.description_coherence)}%;background:${barCol(scores.description_coherence)};border-radius:2px;"></div></div><span style="color:var(--text-sub);">${scores.description_coherence ?? '—'}/25</span></div>
                <div style="display:flex;align-items:center;gap:6px;font-size:9px;"><span style="width:90px;color:var(--text-dim);flex-shrink:0;">Data Quality</span><div style="flex:1;height:4px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;"><div style="height:100%;width:${barPct(scores.data_quality)}%;background:${barCol(scores.data_quality)};border-radius:2px;"></div></div><span style="color:var(--text-sub);">${scores.data_quality ?? '—'}/25</span></div>
            </div>
            ${findings ? `<div style="margin-bottom:6px;">${findings}</div>` : ''}
            ${caveats ? `<div style="margin-bottom:6px;">${caveats}</div>` : ''}
            ${v.reasoning ? `<div style="font-size:9px;color:var(--text-sub);line-height:1.4;padding:6px 8px;background:rgba(255,255,255,0.02);border-left:2px solid var(--border);border-radius:0 4px 4px 0;">${v.reasoning}</div>` : ''}
        </div>`;
    })();

    // ── Build the compact detail body ──
    document.getElementById('detail-title').innerHTML = `
        <i class="fa-solid ${infraIcon}" style="color:${sevColor};margin-right:6px;"></i>
        ${r.infrastructure_type}
        <span class="detail-sev-badge detail-sev-${r.severity}" style="margin-left:8px;font-size:10px;padding:2px 10px;">${r.severity}</span>
        <span class="status-badge status-${r.status}" style="margin-left:4px;">${r.status}</span>
    `;

    document.getElementById('detail-body').innerHTML = `
        <!-- Subtitle: time + sync + auto-submit -->
        <div class="dp-subtitle">
            <span>${timeDisplay(r.server_created_at)}</span>
            ${r.sync_status === 'PARTIAL' ? `<span class="dp-chip dp-chip-warn"><i class="fa-solid fa-cloud-arrow-up"></i> ${r.received_media}/${r.expected_media}</span>` : ''}
            ${r.is_auto_submitted ? '<span class="dp-chip dp-chip-dim"><i class="fa-solid fa-hourglass-end"></i> Auto</span>' : ''}
        </div>

        <!-- Photo + Satellite side-by-side -->
        <div class="dp-images ${v ? '' : 'dp-images-single'}">
            <div class="dp-img-col">
                ${imgHtml}
                <div class="dp-img-ts">Captured: ${formatShortDate(r.server_created_at)}</div>
            </div>
            ${v ? `<div class="dp-img-col">
                ${satHtml}
                <div class="dp-img-ts">${(v.satellite_source || 'Satellite').split(' ')[0]}: ${v.satellite_acquisition_date ? formatShortDate(v.satellite_acquisition_date) : 'N/A'}${v.satellite_days_gap != null ? ` · ${v.satellite_days_gap === 0 ? 'Same day' : v.satellite_days_gap > 0 ? v.satellite_days_gap + 'd before' : Math.abs(v.satellite_days_gap) + 'd after'}` : ''}</div>
            </div>` : ''}
        </div>

        <!-- Evidence strip: audio + transcription -->
        <div class="dp-evidence-strip">
            ${audio ? (
                audioPlayUrl
                    ? `<button class="dp-audio-btn ${aComplete ? '' : 'uploading'}" onclick="playDetailAudio(this, '${audioPlayUrl}')">
                           <i class="fa-solid ${aComplete ? 'fa-play' : 'fa-cloud-arrow-up fa-pulse'}"></i>
                           ${aComplete ? '' : aPct.toFixed(0) + '%'}
                       </button>`
                    : `<span class="dp-audio-pending"><i class="fa-solid fa-microphone" style="color:#475569;"></i> ${aPct > 0 ? aPct.toFixed(0) + '%' : 'Waiting...'}</span>`
            ) : ''}
            <div class="dp-audio-bar-wrap" style="${audioPlayUrl ? '' : 'display:none'}">
                <div class="audio-progress-bar" style="height:3px;"><div class="audio-progress-fill" id="detail-audio-fill"></div></div>
                <div class="audio-time" style="font-size:8px;"><span id="detail-audio-cur">0:00</span><span id="detail-audio-dur">${aComplete ? '0:00' : '--:--'}</span></div>
            </div>
            <div class="dp-transcript-snippet">
                ${ai?.transcription ? `<i class="fa-solid fa-quote-left" style="font-size:7px;color:#475569;margin-right:3px;"></i>${ai.transcription.substring(0, 100)}${ai.transcription.length > 100 ? '...' : ''}` :
                  (r.description ? r.description.substring(0, 100) + (r.description.length > 100 ? '...' : '') : '<span style="color:#475569;">No description</span>')}
            </div>
        </div>

        <!-- Location -->
        ${loc ? (() => {
            const mismatch = loc.is_user_corrected && loc.device_latitude && loc.device_longitude;
            const distKm = mismatch ? Math.round(haversineKm(loc.latitude, loc.longitude, loc.device_latitude, loc.device_longitude)) : 0;
            const userName = loc.user_location_name || `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
            const devName  = loc.device_location_name || `${loc.device_latitude?.toFixed(4)}, ${loc.device_longitude?.toFixed(4)}`;
            return mismatch ? `
            <div class="dp-loc-mismatch">
                <div class="dp-loc-row">
                    <i class="fa-solid fa-location-dot" style="color:${sevColor};"></i>
                    <span class="dp-loc-label">User:</span>
                    <span class="dp-loc-name">${userName}</span>
                    <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${loc.latitude}, ${loc.longitude}'); showToast('User coords copied','success')"><i class="fa-solid fa-copy"></i></button>
                </div>
                <div class="dp-loc-row">
                    <i class="fa-solid fa-mobile-screen" style="color:#94a3b8;"></i>
                    <span class="dp-loc-label">Device:</span>
                    <span class="dp-loc-name">${devName}</span>
                    <span class="dp-loc-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${distKm}km apart</span>
                </div>
            </div>` : `
            <div class="dp-loc-line">
                <i class="fa-solid fa-location-dot" style="color:${sevColor};"></i>
                <span class="dp-loc-name">${locName || userName}</span>
                <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${locLat}, ${locLng}'); showToast('Coords copied','success')"><i class="fa-solid fa-copy"></i></button>
            </div>`;
        })() : ''}

        <!-- Verification score (compact) -->
        ${vGaugeHtml}

        <!-- Primary actions -->
        <div class="dp-actions-primary">
            ${r.status !== 'RESPONDING' ? `<button class="dp-act dp-act-dispatch" onclick="patchReport('${r.id}','dispatch')"><i class="fa-solid fa-truck-medical"></i> Dispatch</button>` : ''}
            ${r.status !== 'RESOLVED' ? `<button class="dp-act dp-act-resolve" onclick="patchReport('${r.id}','resolve')"><i class="fa-solid fa-check-circle"></i> Resolve</button>` : ''}
            ${r.status !== 'FALSE_ALARM' ? `<button class="dp-act dp-act-false" onclick="patchReport('${r.id}','false-alarm')"><i class="fa-solid fa-ban"></i> False</button>` : ''}
        </div>

        <!-- Secondary actions -->
        <div class="dp-actions-secondary">
            <button class="dp-act-sm dp-act-verify" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')">
                <i class="fa-solid fa-satellite"></i> ${v ? 'Re-verify & Report' : 'Verify & Report'}
            </button>
            <button class="dp-act-sm dp-act-delete" onclick="if(confirm('Delete this report permanently?')) deleteReport('${r.id}')">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `;

    if (loc && !skipFly) map.flyTo([loc.latitude, loc.longitude], 15);
    renderFeed();
};

window.switchSatSource = (reportId, which, btn, src) => {
    const img = document.getElementById(`dp-sat-img-${reportId}`);
    if (img) img.src = src;
    btn.parentElement.querySelectorAll('.dp-sat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
};

window.closeDetail = () => {
    selectedId = null;
    document.getElementById('detail-panel').style.display = 'none';
    renderFeed();
};

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
            <span style="font-size:8px; color:var(--text-dim); font-weight:400; margin-left:4px;">${scoredAt}</span>
        </div>

        ${v.error && total === 0 ? `
        <div style="padding:10px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); border-radius:8px; font-size:11px; color:#fca5a5; margin-bottom:10px;">
            <i class="fa-solid fa-triangle-exclamation"></i> ${v.error}
        </div>` : ''}

        <!-- Image comparison -->
        <div class="sat-compare-strip">
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-user"></i> Reporter Photo</div>
                ${userImgSrc
                    ? `<img src="${userImgSrc}" class="sat-compare-img" onclick="openLightbox('${userImgSrc}','User Photo')" title="Click to enlarge">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text-dim);">No photo</div>`
                }
            </div>
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-satellite"></i> Satellite View</div>
                ${satImgSrc
                    ? `<img src="${satImgSrc}" class="sat-compare-img" onclick="openLightbox('${satImgSrc}','Satellite')" title="Click to enlarge — ${v.satellite_source || ''}">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--text-dim);">Unavailable</div>`
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
                    ? `<div style="font-size:9px;color:var(--text-sub);line-height:1.4;">${v.satellite_scene_description}</div>`
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
            const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
            showToast(`Verification failed: ${err.detail || res.status}`, 'error');
            if (btn) {
                btn.classList.remove('verifying');
                btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
                btn.disabled = false;
            }
        }
    } catch (e) {
        showToast('Verification request failed', 'error');
        if (btn) {
            btn.classList.remove('verifying');
            btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
            btn.disabled = false;
        }
    }
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
    } catch (e) { showToast('Action failed', 'error'); }
};

window.deleteReport = async (id) => {
    try {
        const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
        if (res.ok || res.status === 204) {
            allReports = allReports.filter(r => r.id !== id);
            knownIds.delete(id);
            if (selectedId === id) closeDetail();
            showToast('Report deleted', 'success');
            updateMapMarkers();
            renderFeed();
        }
    } catch (e) { showToast('Delete failed', 'error'); }
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
        if (fill && currentAudio.duration) {
            fill.style.width = `${(currentAudio.currentTime / currentAudio.duration) * 100}%`;
            cur.textContent = formatTime(currentAudio.currentTime);
        }
    };
    currentAudio.onloadedmetadata = () => {
        const dur = document.getElementById('detail-audio-dur');
        if (dur) dur.textContent = formatTime(currentAudio.duration);
    };
    currentAudio.onended = () => {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('playing');
    };
};

function formatTime(s) {
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
    map = L.map('crisis-map', { zoomControl: false }).setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Initialize cluster group
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
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
            const size = count > 50 ? 48 : count > 20 ? 40 : count > 5 ? 34 : 28;
            return L.divIcon({
                className: 'crisp-cluster',
                html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid rgba(255,255,255,0.8);display:flex;align-items:center;justify-content:center;font-size:${size > 40 ? 14 : 11}px;font-weight:800;color:#fff;box-shadow:0 2px 12px ${color}80;">${count}</div>`,
                iconSize: [size, size]
            });
        }
    });
    map.addLayer(clusterGroup);
}

function updateMapMarkers() {
    clusterGroup.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    const heatPoints = [];

    allReports.forEach(r => {
        if (!r.location) return;
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const color = SEV_COLORS[r.severity] || '#64748b';

        // Marker for cluster group
        const icon = L.divIcon({
            className: 'crisp-marker',
            html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 6px ${color}80;"></div>`,
            iconSize: [12, 12]
        });
        const marker = L.marker([lat, lng], { icon });
        marker._crispReport = r;
        marker.on('click', () => selectReport(r.id));

        // Tooltip on hover
        marker.bindTooltip(() => {
            const img = r.media?.find(m => m.type === 'IMAGE');
            return `<div style="padding:8px;min-width:180px;">
                ${img ? `<img src="${getMediaUrl(img.url)}" style="width:100%;height:70px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ''}
                <div style="font-weight:700;font-size:11px;color:${color};">${r.severity} — ${r.infrastructure_type}</div>
                <div style="font-size:10px;color:#94a3b8;margin-top:2px;">${(r.description || '').substring(0, 60)}</div>
                <div style="font-size:9px;color:#475569;margin-top:4px;">${timeAgo(r.server_created_at)}</div>
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
    if (!firstZoomDone && allReports.some(r => r.location)) {
        const pts = allReports.filter(r => r.location).map(r => [r.location.latitude, r.location.longitude]);
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
        const res = await fetch(`${API}?include_deleted=true`);
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

    if (_pendingDeletions.length === 0) {
        body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);"><i class="fa-solid fa-circle-check" style="font-size:24px;color:#22c55e;"></i><br>No pending deletions</div>';
        return;
    }

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
                    <span class="detail-sev-badge detail-sev-${r.severity}" style="font-size:9px;padding:1px 8px;">${r.severity}</span>
                </div>
                <div style="font-size:11px;color:var(--text-sub);margin-top:2px;">${loc} · ${timeAgo(r.server_created_at)}</div>
                <div style="font-size:10px;color:${expired ? '#ef4444' : '#f59e0b'};margin-top:4px;display:flex;align-items:center;gap:4px;">
                    <i class="fa-solid ${expired ? 'fa-clock' : 'fa-hourglass-half'}"></i>
                    Deletion requested ${timeAgo(r.deletion_requested_at)} · ${countdown}
                </div>
                <div style="font-size:9px;color:var(--text-dim);margin-top:2px;">Device: ${r.device_id?.substring(0, 8)}... · ID: ${r.id.substring(0, 8)}...</div>
            </div>
        </div>`;
    }).join('');
};

window.closeDeletionsPanel = function () {
    const panel = document.getElementById('deletions-panel');
    if (panel) panel.style.display = 'none';
};

// Check on every poll cycle
const _origFetchReports = fetchReports;

// ── Export Functions ──────────────────────────────────────────────────────────
window.exportData = function (format) {
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
        filtered = filtered.filter(r => new Date(r.server_created_at).getTime() > cutoff);
    }
    return filtered;
}

function exportCSV(reports, filename = 'crisp_export') {
    const headers = ['ID', 'Severity', 'Infrastructure', 'Status', 'Description', 'Latitude', 'Longitude', 'Time', 'Source', 'Country', 'Region'];
    const rows = reports.map(r => [
        r.id, r.severity, r.infrastructure_type, r.status,
        `"${(r.description || '').replace(/"/g, '""')}"`,
        r.location?.latitude || '', r.location?.longitude || '',
        r.server_created_at, r.source, r._country || '', r._region || ''
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
            status: r.status, description: r.description, time: r.server_created_at,
            country: r._country, region: r._region
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
}

async function fetchReports() {
    try {
        const res  = await fetch(API);
        const data = await res.json();
        try {
            localStorage.setItem(REPORTS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch (_) {}
        _updateCacheBadge(false);
        // Apply rendering separately so UI errors don't look like network failures
        try { _applyReportData(data); } catch (e) { console.warn('[CRISP] Render error:', e); }
        // Check for pending deletions (admin indicator)
        _checkPendingDeletions();
    } catch (e) {
        console.warn('[CRISP] Fetch failed (offline?) — using cached data:', e);
        _updateCacheBadge(true);
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
    let badge = document.getElementById('cache-freshness-badge');
    if (!badge) return;
    if (stale) {
        badge.textContent = '⚠ Cached';
        badge.title = 'Showing last cached data — reconnect to refresh';
        badge.style.color = '#f59e0b';
    } else {
        badge.textContent = '● Live';
        badge.title = 'Data is live from server';
        badge.style.color = 'var(--accent, #7c3aed)';
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
document.addEventListener('DOMContentLoaded', async () => {
    initMap();
    await loadWorldData();

    // Show cached data instantly (zero network needed)
    _loadCachedReports();

    // Fetch fresh data, then adaptive polling takes over
    fetchReports();
});
