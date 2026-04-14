// ══════════════════════════════════════════════════════════════════════════════
// CRISP Predictive Intelligence — Frontend Logic
// ══════════════════════════════════════════════════════════════════════════════

const PRED_API = `http://${window.location.hostname || 'localhost'}:8000/api/v1/predictions`;
let _predTimeWindow = 72;
let _predHeatLayer = null;
let _predZoneMarkers = [];

// ── Panel Toggle ─────────────────────────────────────────────────────────────

window.togglePredictions = function () {
    const panel = document.getElementById('predictions-panel');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) loadPredictions();
};

window.setPredTimeWindow = function (hours) {
    _predTimeWindow = hours;
    document.querySelectorAll('.pred-time-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
};

// ── Load Predictions ─────────────────────────────────────────────────────────

async function loadPredictions() {
    try {
        const res = await fetch(`${PRED_API}/latest`);
        if (res.status === 401) return;
        const data = await res.json();
        renderPredictionCards(data);
        renderPredictionHeatmap(data);
    } catch (e) {
        console.warn('[Predictions] Load error:', e);
    }
}

function renderPredictionCards(predictions) {
    const container = document.getElementById('pred-cards');
    const empty = document.getElementById('pred-empty');

    if (!predictions || predictions.length === 0) {
        container.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }
    empty.style.display = 'none';

    const riskColor = (score) => score >= 76 ? '#ef4444' : score >= 51 ? '#f97316' : score >= 21 ? '#eab308' : '#22c55e';
    const riskGlow = (score) => score >= 76 ? 'rgba(239,68,68,0.3)' : score >= 51 ? 'rgba(249,115,22,0.3)' : score >= 21 ? 'rgba(234,179,8,0.2)' : 'rgba(34,197,94,0.2)';
    const crisisIcon = (type) => ({
        FLOOD:'fa-water',EARTHQUAKE:'fa-house-crack',CONFLICT:'fa-shield-halved',
        HURRICANE:'fa-wind',CYCLONE:'fa-tornado',WILDFIRE:'fa-fire',
        LANDSLIDE:'fa-mountain',PANDEMIC:'fa-virus',NONE:'fa-check-circle'
    }[type] || 'fa-triangle-exclamation');

    container.innerHTML = predictions.map(p => {
        const color = riskColor(p.risk_score);
        const glow = riskGlow(p.risk_score);
        const sb = p.signal_breakdown || {};
        const factors = (p.contributing_factors || []).slice(0, 3);

        const barHtml = (label, val) => `
            <div class="pred-bar-row">
                <span class="pred-bar-label">${label}</span>
                <div class="pred-bar-track"><div class="pred-bar-fill" style="width:${Math.min(val,100)}%;background:${val>60?'#f97316':val>30?'#eab308':'#22c55e'};"></div></div>
                <span class="pred-bar-val">${val}</span>
            </div>`;

        return `
        <div class="pred-card" style="border-color:${glow};" onclick="showPredictionDetail('${p.zone_id}')">
            <div class="pred-card-top">
                <div class="pred-score-ring" style="--ring-color:${color};--ring-pct:${p.risk_score};">
                    <span>${p.risk_score}</span>
                </div>
                <div class="pred-card-info">
                    <div class="pred-card-name">${escapeHtml(p.zone_name)}</div>
                    <div class="pred-card-type"><i class="fa-solid ${crisisIcon(p.predicted_crisis_type)}"></i> ${(p.predicted_crisis_type||'UNKNOWN').replace(/_/g,' ')}</div>
                    <div class="pred-card-window"><i class="fa-regular fa-clock"></i> Next ${p.time_window_hours}h</div>
                </div>
                <span class="pred-level-badge" style="background:${color}20;color:${color};">${p.risk_level}</span>
            </div>
            ${p.headline ? `<div class="pred-headline">${escapeHtml(p.headline)}</div>` : ''}
            <div class="pred-signals">
                ${barHtml('Historical', sb.historical_weight || 0)}
                ${barHtml('Weather', sb.weather_weight || 0)}
                ${barHtml('Seismic', sb.seismic_weight || 0)}
                ${barHtml('Geospatial', sb.geospatial_weight || 0)}
                ${barHtml('Conflict', sb.conflict_weight || 0)}
            </div>
            ${factors.length ? `<div class="pred-factors">${factors.map(f => `<div class="pred-factor"><i class="fa-solid fa-circle-info" style="color:#60a5fa;"></i> ${escapeHtml(f)}</div>`).join('')}</div>` : ''}
            ${p.recommended_action ? `<div class="pred-action"><i class="fa-solid fa-lightbulb" style="color:#fbbf24;"></i> ${escapeHtml(p.recommended_action)}</div>` : ''}
        </div>`;
    }).join('');
}

// ── Prediction Heatmap Layer ─────────────────────────────────────────────────

function renderPredictionHeatmap(predictions) {
    if (typeof map === 'undefined' || !map) return;

    // Remove old layer
    if (_predHeatLayer) { map.removeLayer(_predHeatLayer); _predHeatLayer = null; }
    _predZoneMarkers.forEach(m => map.removeLayer(m));
    _predZoneMarkers = [];

    if (!predictions || predictions.length === 0) return;

    // Heatmap
    const points = predictions.map(p => [p.latitude, p.longitude, (p.risk_score || 0) / 100]);
    if (typeof L !== 'undefined' && L.heatLayer) {
        _predHeatLayer = L.heatLayer(points, {
            radius: 50, blur: 35, maxZoom: 10,
            gradient: { 0.2: '#60a5fa', 0.4: '#06b6d4', 0.6: '#fbbf24', 0.8: '#f97316', 1.0: '#7c3aed' },
        }).addTo(map);
    }

    // Zone markers with risk score badges
    const riskColor = (s) => s >= 76 ? '#ef4444' : s >= 51 ? '#f97316' : s >= 21 ? '#eab308' : '#22c55e';
    predictions.forEach(p => {
        const color = riskColor(p.risk_score);
        const marker = L.marker([p.latitude, p.longitude], {
            icon: L.divIcon({
                className: 'pred-zone-marker',
                html: `<div style="background:${color};color:#fff;font-size:11px;font-weight:800;padding:3px 8px;border-radius:12px;border:2px solid rgba(255,255,255,0.9);box-shadow:0 2px 8px ${color}aa;white-space:nowrap;">${p.risk_score}% ${(p.predicted_crisis_type||'').substring(0,5)}</div>`,
                iconSize: [60, 24], iconAnchor: [30, 12],
            }),
        });
        marker.bindTooltip(`<b>${escapeHtml(p.zone_name)}</b><br>${p.risk_level} — ${(p.predicted_crisis_type||'').replace(/_/g,' ')}<br>${p.headline || ''}`, { sticky: true });
        marker.addTo(map);
        _predZoneMarkers.push(marker);
    });
}

// ── Add Zone ─────────────────────────────────────────────────────────────────

window.addPredictionZone = async function () {
    const name = document.getElementById('pred-zone-name').value.trim();
    const lat = parseFloat(document.getElementById('pred-zone-lat').value);
    const lng = parseFloat(document.getElementById('pred-zone-lng').value);

    if (!name || isNaN(lat) || isNaN(lng)) {
        showToast('Enter zone name, latitude, and longitude', 'error');
        return;
    }

    try {
        const res = await fetch(`${PRED_API}/zones`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, latitude: lat, longitude: lng }),
        });
        if (res.ok) {
            showToast('Zone added — running forecast...', 'success');
            document.getElementById('pred-zone-name').value = '';
            document.getElementById('pred-zone-lat').value = '';
            document.getElementById('pred-zone-lng').value = '';
            // Auto-run forecast
            await runForecastForLocation(lat, lng, name);
            loadPredictions();
        } else {
            const d = await res.json();
            showToast(d.detail || 'Failed to add zone', 'error');
        }
    } catch (e) { showToast('Network error', 'error'); }
};

// ── Run Forecast ─────────────────────────────────────────────────────────────

window.runNewForecast = async function () {
    showToast('Running forecasts for all zones...', 'info');
    try {
        const zonesRes = await fetch(`${PRED_API}/zones`);
        if (!zonesRes.ok) return;
        const zones = await zonesRes.json();
        for (const z of zones) {
            await runForecastForLocation(z.latitude, z.longitude, z.name);
        }
        loadPredictions();
        showToast(`Forecasts complete for ${zones.length} zones`, 'success');
    } catch (e) { showToast('Forecast error', 'error'); }
};

async function runForecastForLocation(lat, lng, name) {
    try {
        await fetch(`${PRED_API}/forecast`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latitude: lat, longitude: lng, name, time_window_hours: _predTimeWindow }),
        });
    } catch (e) { console.warn('[Predictions] Forecast error:', e); }
}

// ── Detail Modal ─────────────────────────────────────────────────────────────

window.showPredictionDetail = async function (zoneId) {
    try {
        const res = await fetch(`${PRED_API}/${zoneId}/history`);
        if (!res.ok) return;
        const data = await res.json();
        const zone = data.zone;
        const latest = data.predictions[0];
        if (!latest) return;

        const sb = latest.signal_breakdown || {};
        const barHtml = (label, val) => {
            const color = val > 60 ? '#f97316' : val > 30 ? '#eab308' : '#22c55e';
            return `<div class="ai-logic-bar-row"><span class="ai-logic-label">${label}</span><div class="ai-logic-bar"><div class="ai-logic-bar-fill" style="width:${val}%;background:${color};"></div></div><span class="ai-logic-val" style="color:${color};">${val}</span></div>`;
        };

        const modal = document.createElement('div');
        modal.className = 'ai-logic-overlay';
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.innerHTML = `
            <div class="ai-logic-card" style="max-width:520px;">
                <div class="ai-logic-header">
                    <h3><i class="fa-solid fa-bolt" style="color:#a78bfa;"></i> ${escapeHtml(zone.name)} — Risk Analysis</h3>
                    <button onclick="this.closest('.ai-logic-overlay').remove()" class="ai-logic-close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="ai-logic-body">
                    <div style="text-align:center;margin-bottom:12px;">
                        <div style="font-size:48px;font-weight:900;color:${latest.risk_score >= 76 ? '#ef4444' : latest.risk_score >= 51 ? '#f97316' : '#eab308'};">${latest.risk_score}<small style="font-size:16px;opacity:0.5;">%</small></div>
                        <div style="font-size:13px;font-weight:700;color:#94a3b8;">${latest.risk_level} RISK — ${(latest.predicted_crisis_type||'').replace(/_/g,' ')}</div>
                        ${latest.headline ? `<p style="font-size:12px;color:#cbd5e1;margin-top:6px;">${escapeHtml(latest.headline)}</p>` : ''}
                    </div>
                    <div class="ai-logic-section">
                        <h4>Signal Breakdown</h4>
                        ${barHtml('Historical', sb.historical_weight || 0)}
                        ${barHtml('Weather', sb.weather_weight || 0)}
                        ${barHtml('Seismic', sb.seismic_weight || 0)}
                        ${barHtml('Geospatial', sb.geospatial_weight || 0)}
                        ${barHtml('Conflict', sb.conflict_weight || 0)}
                    </div>
                    ${(latest.contributing_factors||[]).length ? `<div class="ai-logic-section"><h4>Contributing Factors</h4><ul>${latest.contributing_factors.map(f=>`<li><i class="fa-solid fa-circle-info" style="color:#60a5fa;"></i> ${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
                    ${latest.recommended_action ? `<div class="ai-logic-section"><h4>Recommended Action</h4><p style="color:#fbbf24;font-size:13px;"><i class="fa-solid fa-lightbulb"></i> ${escapeHtml(latest.recommended_action)}</p></div>` : ''}
                    ${latest.reasoning ? `<div class="ai-logic-section"><h4>Analysis</h4><p class="ai-logic-reasoning">${escapeHtml(latest.reasoning)}</p></div>` : ''}
                    ${data.predictions.length > 1 ? `<div class="ai-logic-section"><h4>Prediction History</h4>${data.predictions.slice(0,5).map(p => `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:#94a3b8;"><span>${new Date(p.created_at).toLocaleString()}</span><span style="color:${p.risk_score>=51?'#f97316':'#22c55e'};font-weight:700;">${p.risk_score}% ${p.risk_level}</span></div>`).join('')}</div>` : ''}
                </div>
            </div>`;
        document.body.appendChild(modal);
    } catch (e) { console.warn('[Predictions] Detail error:', e); }
};
