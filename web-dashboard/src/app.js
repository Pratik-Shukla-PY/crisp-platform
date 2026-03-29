// ── Config ────────────────────────────────────────────────────────────────────
const BACKEND_HOST = `http://${window.location.hostname || 'localhost'}:8000`;
const API = `${BACKEND_HOST}/api/v1/reports`;
const POLL_INTERVAL = 4000;

// ── State ─────────────────────────────────────────────────────────────────────
let allReports = [];
let sortMode     = 'impact'; 
let timeFilterHours = 24;
let statusFilter = 'active';
let selectedId = null;
const knownIds   = new Set();
const liveMarkers = {};
let firstZoomDone = false;
let heatLayer = null;
let currentAudio = null;
let treeState = {}; 

const SEV_SCORE  = { CRITICAL: 10, SEVERE: 7, MODERATE: 4, MINOR: 2, UNKNOWN: 1 };
const INFRA_WEIGHTS = { HOSPITAL: 10, POWER_PLANT: 8, WATER_TREATMENT: 7, ROAD: 3, BRIDGE: 5, SCHOOL: 4, OTHER: 1 };

const COUNTRY_TO_CONTINENT = {
    // ISO2
    "DZ":"AF", "AO":"AF", "BJ":"AF", "BW":"AF", "BF":"AF", "BI":"AF", "CV":"AF", "CM":"AF", "CF":"AF", "TD":"AF", "KM":"AF", "CD":"AF", "CG":"AF", "DJ":"AF", "EG":"AF", "GQ":"AF", "ER":"AF", "SZ":"AF", "ET":"AF", "GA":"AF", "GM":"AF", "GH":"AF", "GN":"AF", "GW":"AF", "CI":"AF", "KE":"AF", "LS":"AF", "LR":"AF", "LY":"AF", "MG":"AF", "MW":"AF", "ML":"AF", "MR":"AF", "MU":"AF", "YT":"AF", "MA":"AF", "MZ":"AF", "NA":"AF", "NE":"AF", "NG":"AF", "RE":"AF", "RW":"AF", "SH":"AF", "ST":"AF", "SN":"AF", "SC":"AF", "SL":"AF", "SO":"AF", "ZA":"AF", "SS":"AF", "SD":"AF", "TZ":"AF", "TG":"AF", "TN":"AF", "UG":"AF", "EH":"AF", "ZM":"AF", "ZW":"AF",
    "AF":"AS", "AM":"AS", "AZ":"AS", "BH":"AS", "BD":"AS", "BT":"AS", "BN":"AS", "KH":"AS", "CN":"AS", "CY":"AS", "GE":"AS", "HK":"AS", "IN":"AS", "ID":"AS", "IR":"AS", "IQ":"AS", "IL":"AS", "JP":"AS", "JO":"AS", "KZ":"AS", "KP":"AS", "KR":"AS", "KW":"AS", "KG":"AS", "LA":"AS", "LB":"AS", "MO":"AS", "MY":"AS", "MV":"AS", "MN":"AS", "MM":"AS", "NP":"AS", "OM":"AS", "PK":"AS", "PS":"AS", "PH":"AS", "QA":"AS", "SA":"AS", "SG":"AS", "LK":"AS", "SY":"AS", "TW":"AS", "TJ":"AS", "TH":"AS", "TL":"AS", "TR":"AS", "TM":"AS", "UZ":"AS", "VN":"AS", "YE":"AS",
    "AL":"EU", "AD":"EU", "AT":"EU", "BY":"EU", "BE":"EU", "BA":"EU", "BG":"EU", "HR":"EU", "CZ":"EU", "DK":"EU", "EE":"EU", "FO":"EU", "FI":"EU", "FR":"EU", "DE":"EU", "GI":"EU", "GR":"EU", "HU":"EU", "IS":"EU", "IE":"EU", "IT":"EU", "LV":"EU", "LI":"EU", "LT":"EU", "LU":"EU", "MK":"EU", "MT":"EU", "MD":"EU", "MC":"EU", "ME":"EU", "NL":"EU", "NO":"EU", "PL":"EU", "PT":"EU", "RO":"EU", "RU":"EU", "SM":"EU", "RS":"EU", "SK":"EU", "SI":"EU", "ES":"EU", "SJ":"EU", "SE":"EU", "CH":"EU", "UA":"EU", "GB":"EU", "VA":"EU",
    "AI":"NA", "AG":"NA", "AW":"NA", "BS":"NA", "BB":"NA", "BZ":"NA", "BM":"NA", "VG":"NA", "CA":"NA", "KY":"NA", "CR":"NA", "CU":"NA", "CW":"NA", "DM":"NA", "DO":"NA", "SV":"NA", "GL":"NA", "GD":"NA", "GP":"NA", "GT":"NA", "HT":"NA", "HN":"NA", "JM":"NA", "MQ":"NA", "MX":"NA", "MS":"NA", "KN":"NA", "LC":"NA", "PM":"NA", "VC":"NA", "SX":"NA", "TT":"NA", "TC":"NA", "US":"NA",
    "AS":"OC", "AU":"OC", "CK":"OC", "FJ":"OC", "PF":"OC", "GU":"OC", "KI":"OC", "MH":"OC", "FM":"OC", "NR":"OC", "NC":"OC", "NZ":"OC", "NU":"OC", "NF":"OC", "MP":"OC", "PW":"OC", "PG":"OC", "PN":"OC", "WS":"OC", "SB":"OC", "TK":"OC", "TO":"OC", "TV":"OC", "UM":"OC", "VU":"OC", "WF":"OC",
    "AR":"SA", "BO":"SA", "BR":"SA", "CL":"SA", "CO":"SA", "EC":"SA", "FK":"SA", "GF":"SA", "GY":"SA", "PY":"SA", "PE":"SA", "SR":"SA", "UY":"SA", "VE":"SA",
    "AQ":"AN",
    // ISO3 Common (UN Missions)
    "AFG":"AS", "IND":"AS", "USA":"NA", "GBR":"EU", "FRA":"EU", "DEU":"EU", "ITA":"EU", "ESP":"EU", "CAN":"NA", "MEX":"NA", "BRA":"SA", "ARG":"SA", "ZAF":"AF", "NGA":"AF", "KEN":"AF", "ETH":"AF", "EGY":"AF", "DZA":"AF", "MAR":"AF", "SDN":"AF", "SSD":"AF", "COD":"AF", "UGA":"AF", "SOM":"AF", "MLI":"AF", "NER":"AF", "TCD":"AF", "CAF":"AF", "UKR":"EU", "RUS":"EU", "CHN":"AS", "JPN":"AS", "AUS":"OC", "NZL":"OC", "POL":"EU", "CHE":"EU"
};

const ISO2_TO_ISO3 = { "AF":"AFG", "AL":"ALB", "DZ":"DZA", "AD":"AND", "AO":"AGO", "AG":"ATG", "AR":"ARG", "AM":"ARM", "AU":"AUS", "AT":"AUT", "AZ":"AZE", "BS":"BHS", "BH":"BHR", "BD":"BGD", "BB":"BRB", "BY":"BLR", "BE":"BEL", "BZ":"BLZ", "BJ":"BEN", "BT":"BTN", "BO":"BOL", "BA":"BIH", "BW":"BWA", "BR":"BRA", "BN":"BRN", "BG":"BGR", "BF":"BFA", "BI":"BDI", "KH":"KHM", "CM":"CMR", "CA":"CAN", "CV":"CPV", "CF":"CAF", "TD":"TCD", "CL":"CHL", "CN":"CHN", "CO":"COL", "KM":"COM", "CG":"COG", "CD":"COD", "CR":"CRI", "CI":"CIV", "HR":"HRV", "CU":"CUB", "CY":"CYP", "CZ":"CZE", "DK":"DNK", "DJ":"DJI", "DM":"DMA", "DO":"DOM", "EC":"ECU", "EG":"EGY", "SV":"SLV", "GQ":"GNQ", "ER":"ERI", "EE":"EST", "ET":"ETH", "FJ":"FJI", "FI":"FIN", "FR":"FRA", "GA":"GAB", "GM":"GMB", "GE":"GEO", "DE":"DEU", "GH":"GHA", "GR":"GRC", "GD":"GRD", "GT":"GTM", "GN":"GIN", "GW":"GNB", "GY":"GUY", "HT":"HTI", "HN":"HND", "HU":"HUN", "IS":"ISL", "IN":"IND", "ID":"IDN", "IR":"IRN", "IQ":"IRQ", "IE":"IRL", "IL":"ISR", "IT":"ITA", "JM":"JAM", "JP":"JPN", "JO":"JOR", "KZ":"KAZ", "KE":"KEN", "KI":"KIR", "KP":"PRK", "KR":"KOR", "KW":"KWT", "KG":"KGZ", "LA":"LAO", "LV":"LVA", "LB":"LBN", "LS":"LSO", "LR":"LBR", "LY":"LBY", "LI":"LIE", "LT":"LTU", "LU":"LUX", "MK":"MKD", "MG":"MDG", "MW":"MWI", "MY":"MYS", "MV":"MDV", "ML":"MLI", "MT":"MLT", "MH":"MHL", "MR":"MRT", "MU":"MUS", "MX":"MEX", "FM":"FSM", "MD":"MDA", "MC":"MCO", "MN":"MNG", "ME":"MNE", "MA":"MAR", "MZ":"MOZ", "MM":"MMR", "NA":"NAM", "NR":"NRU", "NP":"NPL", "NL":"NLD", "NZ":"NZL", "NI":"NIC", "NE":"NER", "NG":"NGA", "NO":"NOR", "OM":"OMN", "PK":"PAK", "PW":"PLW", "PA":"PAN", "PG":"PNG", "PY":"PRY", "PE":"PER", "PH":"PHL", "PL":"POL", "PT":"PRT", "QA":"QAT", "RO":"ROU", "RU":"RUS", "RW":"RWA", "KN":"KNA", "LC":"LCA", "VC":"VCT", "WS":"WSM", "SM":"SMR", "ST":"STP", "SA":"SAU", "SN":"SEN", "RS":"SRB", "SC":"SYC", "SL":"SLE", "SG":"SGP", "SK":"SVK", "SI":"SVN", "SB":"SLB", "SO":"SOM", "ZA":"ZAF", "SS":"SSD", "ES":"ESP", "LK":"LKA", "SD":"SDN", "SR":"SUR", "SZ":"SWZ", "SE":"SWE", "CH":"CHE", "SY":"SYR", "TJ":"TJK", "TZ":"TZA", "TH":"THA", "TL":"TLS", "TG":"TGO", "TO":"TON", "TT":"TTO", "TN":"TUN", "TR":"TUR", "TM":"TKM", "TV":"TUV", "UG":"UGA", "UA":"UKR", "AE":"ARE", "GB":"GBR", "US":"USA", "UY":"URY", "UZ":"UZB", "VU":"VUT", "VE":"VEN", "VN":"VNM", "YE":"YEM", "ZM":"ZMB", "ZW":"ZWE" };

const CONTINENT_NAMES = { "AF":"Africa", "AS":"Asia", "EU":"Europe", "NA":"North America", "OC":"Oceania", "SA":"South America", "AN":"Antarctica" };

const getMediaUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http')) return url;
    return `${BACKEND_HOST}/${url.replace(/^\//,'')}`;
};

function timeAgo(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Just now';
    const diff = (Date.now() - d) / 1000;
    if (diff < 60)   return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff/60)}m ago`;
    if (diff < 86400)return `${Math.round(diff/3600)}h ago`;
    return `${Math.round(diff/86400)}d ago`;
}

function showToast(msg) { console.log('Toast:', msg); }

// ── Hierarchy Logic ───────────────────────────────────────────────────────────
function buildControlPanelTree(reports) {
    const tree = {};
    reports.forEach(r => {
        const cont = CONTINENT_NAMES[r._continent_code] || 'Global';
        const coun = r._country || 'Unknown Country';
        const reg  = r._region || 'Unknown Region';
        const type = r.infrastructure_type || 'OTHER';
        const sev  = r.severity || 'UNKNOWN';
        const st   = r.status || 'PENDING';

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

function calculateNodeMetrics(data) {
    if (Array.isArray(data)) {
        const s = { p1:0, p2:0, p3:0, total:data.length, latest:0, impact:0, infra:0 };
        data.forEach(r => {
            if (r.severity === 'CRITICAL' || r.severity === 'SEVERE') s.p1++;
            else if (r.severity === 'MODERATE') s.p2++;
            else s.p3++;
            const t = new Date(r.server_created_at).getTime();
            if (t > s.latest) s.latest = t;
            s.impact += (SEV_SCORE[r.severity] || 1) * (INFRA_WEIGHTS[r.infrastructure_type] || 1);
            if (INFRA_WEIGHTS[r.infrastructure_type] > 1) s.infra++;
        });
        return s;
    }
    const agg = { p1:0, p2:0, p3:0, total:0, latest:0, impact:0, infra:0 };
    Object.values(data).forEach(c => {
        const m = calculateNodeMetrics(c);
        agg.p1 += m.p1; agg.p2 += m.p2; agg.p3 += m.p3; agg.total += m.total;
        if (m.latest > agg.latest) agg.latest = m.latest;
        agg.impact += m.impact; agg.infra += m.infra;
    });
    return agg;
}

// ── UI Rendering ──────────────────────────────────────────────────────────────
function createTreeHeader(label, stats, level, path, isExpanded) {
    const div = document.createElement('div');
    div.className = `tree-header level-${level} ${isExpanded ? 'expanded' : ''}`;
    div.onclick = (e) => { e.stopPropagation(); toggleTreeNode(path); focusMapOnNode(path); };
    
    const impact = Math.round(stats.impact / (stats.total || 1));
    const urgency = impact > 25 ? 'HIGH' : (impact > 10 ? 'MEDIUM' : 'LOW');

    div.innerHTML = `
        <span class="chevron"><i class="fa-solid fa-chevron-right"></i></span>
        <span class="tree-label">${label}</span>
        <div class="tree-metrics">
            ${stats.p1 > 0 ? `<span class="m-badge p1">${stats.p1}</span>` : ''}
            <span class="m-badge total">${stats.total}</span>
            <span class="m-score urgency-${urgency}">Score: ${impact}</span>
        </div>
    `;
    return div;
}

function renderTreeLevel(parentEl, data, levelIndex, currentPath) {
    const levels = ['continent', 'country', 'region', 'type', 'severity', 'status'];
    const levelName = levels[levelIndex];
    if (!levelName) return;

    const keys = Object.keys(data).sort((a,b) => calculateNodeMetrics(data[b]).impact - calculateNodeMetrics(data[a]).impact);
    keys.forEach(key => {
        const path = currentPath ? `${currentPath}|${key}` : key;
        if (treeState[path] === undefined && levelIndex <= 2) treeState[path] = true;
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
                data[key].forEach(r => {
                    const inc = document.createElement('div');
                    inc.className = `tree-incident ${selectedId === r.id ? 'selected' : ''}`;
                    inc.onclick = (e) => { e.stopPropagation(); selectReport(r.id); };
                    inc.innerHTML = `
                        <span class="inc-sev-dot sev-dot-${r.severity}"></span>
                        <span class="inc-desc">${(r.description || 'No description').substring(0, 32)}...</span>
                    `;
                    inc.onmouseenter = (e) => showIncidentPreview(r, e.clientX, e.clientY);
                    inc.onmouseleave = hideIncidentPreview;
                    content.appendChild(inc);
                });
            }
            node.appendChild(content);
        }
        parentEl.appendChild(node);
    });
}

function renderFeed() {
    const el = document.getElementById('report-feed-list');
    if (!el) return;
    const filtered = allReports.filter(r => {
        const s = r.status;
        if (statusFilter === 'active') return s === 'PENDING' || s === 'VERIFIED';
        return s.toLowerCase() === statusFilter.toLowerCase();
    });
    el.innerHTML = '';
    const tree = buildControlPanelTree(filtered);
    const frag = document.createDocumentFragment();
    renderTreeLevel(frag, tree, 0, "");
    el.appendChild(frag);
    document.getElementById('feed-count-badge').textContent = `${filtered.length} Active`;
}

// ── Incident Preview & Map ───────────────────────────────────────────────────
function showIncidentPreview(r, x, y) {
    let p = document.getElementById('fast-preview');
    if (!p) { p = document.createElement('div'); p.id = 'fast-preview'; p.className = 'glass-panel fast-preview-tooltip'; document.body.appendChild(p); }
    const img = r.media?.find(m => m.type === 'IMAGE');
    p.innerHTML = `${img ? `<img src="${getMediaUrl(img.url)}" class="fp-img">` : ''}<div class="fp-main"><div class="fp-title">${r.infrastructure_type}</div><div class="fp-desc">${r.description || ''}</div></div>`;
    p.style.display = 'flex'; p.style.left = `${x+20}px`; p.style.top = `${y-40}px`;
}
function hideIncidentPreview() { const p = document.getElementById('fast-preview'); if(p) p.style.display='none'; }

let map;
function initMap() {
    map = L.map('crisis-map', { zoomControl: false }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
}

function updateMapMarkers() {
    Object.values(liveMarkers).forEach(m => map.removeLayer(m.marker));
    allReports.forEach(r => {
        if (!r.location) return;
        const color = { CRITICAL:'#ef4444', SEVERE:'#f97316', MODERATE:'#eab308' }[r.severity] || '#64748b';
        const icon = L.divIcon({ className:'m-icon', html:`<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;"></div>`, iconSize:[12,12] });
        const m = L.marker([r.location.latitude, r.location.longitude], { icon }).addTo(map).on('click', () => selectReport(r.id));
        liveMarkers[r.id] = { marker: m };
    });
}

function focusMapOnNode(path) {
    const parts = path.split('|');
    let cur = buildControlPanelTree(allReports);
    for (const p of parts) if (cur[p]) cur = cur[p];
    const incs = findIncs(cur);
    if (incs.length > 0) map.flyToBounds(L.latLngBounds(incs.map(r => [r.location.latitude, r.location.longitude])), { padding: [50,50] });
}
function findIncs(d) { return Array.isArray(d) ? d : Object.values(d).flatMap(findIncs); }

// ── State Changers ───────────────────────────────────────────────────────────
window.toggleTreeNode = (p) => { treeState[p] = !treeState[p]; renderFeed(); };
window.setStatusFilter = (f) => { statusFilter = f; renderFeed(); };
window.setTimeFilter = (h) => { timeFilterHours = h; renderFeed(); };
window.selectReport = (id) => { 
    selectedId = id; 
    const r = allReports.find(x => x.id === id);
    if (r) {
        document.getElementById('detail-panel').style.display = 'flex';
        document.getElementById('detail-title').textContent = r.infrastructure_type;
        document.getElementById('detail-body').innerHTML = `<p>${r.description}</p>`;
        map.flyTo([r.location.latitude, r.location.longitude], 15);
    }
    renderFeed();
};
window.closeDetail = () => { selectedId = null; document.getElementById('detail-panel').style.display='none'; renderFeed(); };

// ── Geocoding (Offline-First) ────────────────────────────────────────────────
let worldGeoJSON = null;
const geoCache = JSON.parse(localStorage.getItem('crisp_geo_cache') || '{}');

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
    for (const r of reports) {
        if (!r.location || (r._region && r._region !== 'Unknown Region')) continue;
        
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;

        // 1. Precise Offline Check (Country/Continent/Fallback Region)
        const offline = offlineGeocode(lat, lng);
        if (offline) {
            r._country = offline.country;
            r._continent_code = offline.continent_code;
            if (!r._region || r._region === 'Unknown Region') r._region = offline.region_fallback;
            changed = true;
        }

        // 2. Regional Check (Cache -> API)
        if (geoCache[cacheKey]) {
            const c = geoCache[cacheKey];
            r._region = c.nm; r._country = c.co; r._continent_code = c.cc;
            changed = true;
        } else {
            // Background enrichment for Region (City level)
            (async () => {
                try {
                    // Try geocode.maps.co (Better CORS than Nominatim)
                    const res = await fetch(`https://geocode.maps.co/reverse?lat=${lat}&lon=${lng}&format=json`, { mode:'cors' });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.address) {
                            const a = data.address;
                            const nm = a.city || a.town || a.village || a.suburb || a.state || a.country;
                            const cc = (a.country_code || '').toUpperCase();
                            const iso3 = ISO2_TO_ISO3[cc] || cc;
                            const continent = COUNTRY_TO_CONTINENT[iso3] || COUNTRY_TO_CONTINENT[cc] || 'Global';
                            
                            geoCache[cacheKey] = { nm, co: a.country, cc: continent };
                            localStorage.setItem('crisp_geo_cache', JSON.stringify(geoCache));
                            
                            r._region = nm; r._country = a.country; r._continent_code = continent;
                            renderFeed(); 
                        }
                    }
                } catch(e) {
                    // Fallback to nominatim if maps.co fails
                    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`, { headers:{'User-Agent':'CRISP'} })
                    .then(res => res.json())
                    .then(data => {
                        if (data && data.address) {
                            const a = data.address;
                            const nm = a.city || a.town || a.village || a.suburb || a.country;
                            const cc = (a.country_code || '').toUpperCase();
                            const iso3 = ISO2_TO_ISO3[cc] || cc;
                            const continent = COUNTRY_TO_CONTINENT[iso3] || COUNTRY_TO_CONTINENT[cc] || 'Global';
                            geoCache[cacheKey] = { nm, co: a.country, cc: continent };
                            localStorage.setItem('crisp_geo_cache', JSON.stringify(geoCache));
                            r._region = nm; r._country = a.country; r._continent_code = continent;
                            renderFeed(); 
                        }
                    }).catch(err => {});
                }
            })();
        }
    }
    if (changed) renderFeed();
}

async function fetchReports() {
    try {
        const res = await fetch(API);
        const data = await res.json();
        data.forEach(r => { if (!knownIds.has(r.id)) { knownIds.add(r.id); allReports.push(r); } });
        updateGeodata(allReports);
        updateMapMarkers();
        renderFeed();
    } catch(e) {}
}

document.addEventListener('DOMContentLoaded', async () => { 
    initMap(); 
    await loadWorldData();
    fetchReports(); 
    setInterval(fetchReports, POLL_INTERVAL); 
});
