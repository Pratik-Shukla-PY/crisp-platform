// ══════════════════════════════════════════════════════════════════════════════
// CRISP — Public Evidence Page  (Phase C.2, May 2026 UNDP-grade rebuild)
// ══════════════════════════════════════════════════════════════════════════════
//
// Standalone page — no auth, no app.js, no dashboard.css. Loaded via:
//   evidence.html?id=<report_id>
//
// Fetches /api/v1/reports/<id>/evidence and renders a clean truth-score
// card with citizen photo + multi-source satellite grid + AI verdict.
//
// Trust model matches the existing presigned-URL pattern: anyone with
// the report_id (a UUID) can view. Listing report_ids still requires
// authenticated access via /api/v1/reports/.

(function () {
    'use strict';

    // ── Config: backend host detection ──
    // Same logic as app.js — same-origin in PROD, localhost:8000 in dev.
    const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
    const BACKEND_HOST = _isLocalDev
        ? `http://${window.location.hostname}:8000`
        : window.location.origin;

    // ── Read ?id= from URL ──
    const params = new URLSearchParams(window.location.search);
    const reportId = params.get('id');
    const root = document.getElementById('ev-root');

    if (!reportId) {
        renderError('Missing <code>?id=</code> parameter — open this page from the dashboard\'s "Share evidence" button.');
        return;
    }
    // Soft validation — UUIDs are 36 chars w/ hyphens. We don't reject
    // non-UUID values (legacy ids could differ); just guard against
    // path-injection nonsense.
    if (reportId.length > 64 || /[^a-zA-Z0-9-]/.test(reportId)) {
        renderError('Invalid report id.');
        return;
    }

    fetchEvidence();

    // ── HTML escaping (mirrors app.js::escapeHtml) ──
    function esc(s) {
        if (s == null) return '';
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    // ── Resolve a backend-routed URL to a fully-qualified one ──
    // Mirrors app.js::getMediaUrl: relative paths get BACKEND_HOST
    // prefix; absolute http(s):// passes through.
    function resolveUrl(url) {
        if (!url) return '';
        if (url.startsWith('data:') || url.startsWith('http')) return url;
        return `${BACKEND_HOST}/${url.replace(/^\//, '')}`;
    }

    // ── Severity → colour (UNDP-aligned palette) ──
    function severityClass(sev) {
        return `ev-sev-${sev || 'UNKNOWN'}`;
    }

    // ── Score → colour ──
    function scoreColor(total) {
        if (total >= 80) return '#22c55e';
        if (total >= 60) return '#86efac';
        if (total >= 40) return '#eab308';
        if (total >= 20) return '#f97316';
        return '#ef4444';
    }

    // ── Sign-aware days-gap label ──
    // Matches the dashboard helper (vGaugeHtml) so judges see consistent
    // language across the dashboard + evidence pages. Positive gap =
    // satellite captured BEFORE incident; negative = AFTER.
    function gapLabel(gap) {
        if (typeof gap !== 'number') return null;
        if (gap === 0) return { text: 'same day as incident', color: '#22c55e' };
        if (gap > 0) {
            const color = gap <= 3 ? '#22c55e' : gap <= 14 ? '#eab308' : '#f97316';
            return { text: `${gap}d before incident`, color };
        }
        const after = Math.abs(gap);
        const color = after <= 7 ? '#22c55e' : after <= 30 ? '#eab308' : '#f97316';
        return { text: `${after}d after incident`, color };
    }

    function cloudColor(pct) {
        if (typeof pct !== 'number') return '#94a3b8';
        if (pct <= 30) return '#22c55e';
        if (pct <= 70) return '#eab308';
        return '#ef4444';
    }

    // ── Date formatting ──
    function ensureUTC(iso) {
        if (!iso) return iso;
        const s = String(iso).trim();
        if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) return s;
        return s + 'Z';
    }
    function shortDate(iso) {
        if (!iso) return '';
        const d = new Date(ensureUTC(iso));
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function timeAgo(iso) {
        if (!iso) return '';
        const d = new Date(ensureUTC(iso));
        if (isNaN(d.getTime())) return '';
        const diff = (Date.now() - d) / 1000;
        if (diff < 60) return `${Math.round(diff)}s ago`;
        if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
        return `${Math.round(diff / 86400)}d ago`;
    }

    // ── Fetch + render orchestration ──
    async function fetchEvidence() {
        try {
            const url = `${BACKEND_HOST}/api/v1/reports/${encodeURIComponent(reportId)}/evidence`;
            const res = await fetch(url);
            if (res.status === 404) {
                renderError('We couldn\'t find this verification record. The report may have been deleted, or the link is incorrect.');
                return;
            }
            if (!res.ok) {
                renderError(`Server error (${res.status}). Please try again later.`);
                return;
            }
            const data = await res.json();
            render(data);
        } catch (e) {
            renderError('Network error — check your connection and reload.');
        }
    }

    function renderError(msg) {
        root.innerHTML = `
            <div class="ev-status">
                <i class="fa-solid fa-circle-exclamation" style="color:#f87171;"></i>
                ${esc(msg)}
            </div>`;
    }

    function render(data) {
        const incident = renderIncidentHeader(data);
        const evidence = renderEvidenceCards(data);
        const verdict = renderVerdictCard(data);
        const reasoning = renderReasoningSection(data);
        root.innerHTML = incident + verdict + evidence + reasoning;
    }

    // ── Sub-render fns ──

    function renderIncidentHeader(data) {
        const sevClass = severityClass(data.severity);
        const infraName = data.infrastructure_name
            ? esc(data.infrastructure_name)
            : (data.infrastructure_type ? esc(data.infrastructure_type.replace(/_/g, ' ')) : 'Incident');
        const locName = data.location?.name || (
            data.location ? `${data.location.latitude.toFixed(4)}, ${data.location.longitude.toFixed(4)}` : 'Unknown location'
        );
        const reportedAt = data.server_created_at
            ? `${shortDate(data.server_created_at)} · ${timeAgo(data.server_created_at)}`
            : '';
        return `
        <section class="ev-incident-card">
            <div class="ev-incident-row">
                <span class="ev-sev-badge ${sevClass}">${esc(data.severity || 'UNKNOWN')}</span>
                ${data.crisis_type ? `<span class="ev-meta-chip"><i class="fa-solid fa-cloud-bolt"></i> ${esc(data.crisis_type.replace(/_/g, ' '))}</span>` : ''}
                ${data.damage_classification ? `<span class="ev-meta-chip"><i class="fa-solid fa-building-circle-xmark"></i> ${esc(data.damage_classification)}</span>` : ''}
            </div>
            <div class="ev-incident-title">
                <i class="fa-solid fa-triangle-exclamation" style="color:#fbbf24;"></i>
                ${infraName}
            </div>
            <div class="ev-incident-meta">
                <span><i class="fa-solid fa-location-dot"></i>${esc(locName)}</span>
                ${reportedAt ? `<span><i class="fa-regular fa-clock"></i>${reportedAt}</span>` : ''}
                ${data.location ? `<span><i class="fa-solid fa-globe"></i>${data.location.latitude.toFixed(4)}, ${data.location.longitude.toFixed(4)}</span>` : ''}
            </div>
            ${data.description ? `<p class="ev-incident-desc">${esc(data.description)}</p>` : ''}
        </section>`;
    }

    function renderEvidenceCards(data) {
        const photoSrc = resolveUrl(data.photo_url);
        const v = data.verification;
        const sources = (v?.satellite_images || []).slice(0, 4);

        const photoHtml = photoSrc
            ? `<img src="${photoSrc}" alt="Citizen photo" class="ev-photo" />`
            : `<div class="ev-status" style="padding:40px 0;">
                  <i class="fa-solid fa-camera-slash"></i>
                  No citizen photo on file.
              </div>`;

        let satHtml;
        if (sources.length >= 2) {
            satHtml = `<div class="ev-sat-grid">${
                sources.map(s => {
                    const src = resolveUrl(s.url);
                    const acq = s.acquisition_date ? shortDate(s.acquisition_date) : '';
                    const cloud = (typeof s.cloud_cover_pct === 'number')
                        ? `${s.cloud_cover_pct.toFixed(0)}% cloud` : '';
                    const meta = [acq, cloud].filter(Boolean).join(' · ');
                    return `<div class="ev-sat-cell">
                        ${src ? `<img src="${src}" alt="${esc(s.source || 'Satellite')}" />` : ''}
                        <div class="ev-sat-overlay">
                            <span class="ev-sat-source">${esc(s.source || 'Satellite')}</span>
                            ${meta ? `<span class="ev-sat-meta-line">${esc(meta)}</span>` : ''}
                        </div>
                    </div>`;
                }).join('')
            }</div>`;
        } else if (v?.primary_url) {
            const src = resolveUrl(v.primary_url);
            satHtml = `<img src="${src}" alt="Satellite imagery" class="ev-photo" />`;
        } else {
            satHtml = `<div class="ev-status" style="padding:40px 0;">
                <i class="fa-solid fa-satellite-dish"></i>
                Satellite verification has not run yet.
            </div>`;
        }

        return `
        <div class="ev-evidence-grid">
            <section class="ev-card">
                <div class="ev-card-header"><i class="fa-solid fa-camera"></i> Citizen photo</div>
                <div class="ev-card-body">${photoHtml}</div>
            </section>
            <section class="ev-card">
                <div class="ev-card-header"><i class="fa-solid fa-satellite"></i> Satellite imagery</div>
                <div class="ev-card-body">${satHtml}</div>
            </section>
        </div>`;
    }

    function renderVerdictCard(data) {
        const v = data.verification;
        if (!v) {
            return `
            <section class="ev-verdict-card">
                <div class="ev-verdict-row">
                    <i class="fa-solid fa-hourglass-half" style="font-size:20px;color:var(--text-dim);"></i>
                    <span style="color:var(--text-sub);">Verification has not run yet for this report.</span>
                </div>
            </section>`;
        }
        const total = v.total_score || 0;
        const color = scoreColor(total);
        const verdictLabels = {
            STRONGLY_CORROBORATED: 'Strongly Corroborated',
            LIKELY_AUTHENTIC: 'Likely Authentic',
            PARTIALLY_VERIFIED: 'Partially Verified',
            LOW_CONFIDENCE: 'Low Confidence',
            UNVERIFIED: 'Unverified',
        };
        const verdict = verdictLabels[v.verdict] || v.verdict || 'Verified';

        // ── Meta chips ──
        const chips = [];
        if (v.satellite_acquisition_date) {
            const acq = shortDate(v.satellite_acquisition_date);
            const gap = gapLabel(v.satellite_days_gap);
            chips.push(`<span class="ev-meta-chip" style="border-color:${(gap?.color || '#94a3b8')}40;">
                <i class="fa-regular fa-calendar"></i>
                ${esc(acq)}
                ${gap ? `<span style="color:${gap.color};font-weight:600;">· ${esc(gap.text)}</span>` : ''}
            </span>`);
        }
        if (typeof v.satellite_cloud_cover_pct === 'number') {
            const cc = cloudColor(v.satellite_cloud_cover_pct);
            chips.push(`<span class="ev-meta-chip" style="border-color:${cc}40;">
                <i class="fa-solid fa-cloud" style="color:${cc};"></i>
                <span style="font-weight:600;">${v.satellite_cloud_cover_pct.toFixed(0)}% cloud</span>
            </span>`);
        }
        const sourceCount = (v.satellite_images || []).length;
        if (sourceCount >= 2) {
            chips.push(`<span class="ev-meta-chip">
                <i class="fa-solid fa-layer-group"></i>
                ${sourceCount} satellite sources
            </span>`);
        } else if (v.satellite_source) {
            chips.push(`<span class="ev-meta-chip">
                <i class="fa-solid fa-satellite-dish"></i>
                ${esc(v.satellite_source.split('(')[0].trim())}
            </span>`);
        }
        if (v.scored_at) {
            chips.push(`<span class="ev-meta-chip" title="${esc(new Date(ensureUTC(v.scored_at)).toLocaleString())}">
                <i class="fa-solid fa-clock-rotate-left"></i>
                Verified ${timeAgo(v.scored_at)}
            </span>`);
        }

        // ── Sub-scores ──
        const subScores = v.scores || {};
        const subScoreRows = [
            ['location_authenticity', 'Location authenticity', 25],
            ['damage_corroboration', 'Damage corroboration', 25],
            ['description_coherence', 'Description coherence', 25],
            ['data_quality', 'Data quality', 25],
        ].map(([k, label, max]) => {
            const val = subScores[k];
            if (val == null) return '';
            const pctOfMax = Math.round((val / max) * 100);
            const c = scoreColor(pctOfMax);
            return `<div class="ev-sub-score">
                <span class="ev-sub-score-label">${esc(label)}</span>
                <span class="ev-sub-score-value" style="color:${c};">${val}/${max}</span>
            </div>`;
        }).join('');

        return `
        <section class="ev-verdict-card">
            <div class="ev-verdict-row">
                <span class="ev-score-gauge" style="color:${color};">${total}<small>/100</small></span>
                <span class="ev-verdict-label" style="background:${color}1a;color:${color};">${esc(verdict)}</span>
                <div class="ev-score-bar"><div class="ev-score-bar-fill" style="width:${total}%;background:${color};"></div></div>
            </div>
            ${chips.length ? `<div class="ev-meta-chips">${chips.join('')}</div>` : ''}
            ${subScoreRows ? `<div class="ev-sub-scores">${subScoreRows}</div>` : ''}
        </section>`;
    }

    function renderReasoningSection(data) {
        const v = data.verification;
        if (!v) return '';
        const blocks = [];
        if (v.reasoning) {
            blocks.push(`
            <section class="ev-section">
                <h3><i class="fa-solid fa-brain"></i> AI reasoning</h3>
                <p>${esc(v.reasoning)}</p>
            </section>`);
        }
        if (v.satellite_scene_description) {
            blocks.push(`
            <section class="ev-section">
                <h3><i class="fa-solid fa-image"></i> Satellite scene description</h3>
                <p>${esc(v.satellite_scene_description)}</p>
            </section>`);
        }
        if (v.photo_analysis) {
            blocks.push(`
            <section class="ev-section">
                <h3><i class="fa-solid fa-magnifying-glass"></i> Citizen photo analysis</h3>
                <p>${esc(v.photo_analysis)}</p>
            </section>`);
        }
        if (Array.isArray(v.key_findings) && v.key_findings.length) {
            blocks.push(`
            <section class="ev-section">
                <h3><i class="fa-solid fa-circle-check"></i> Key findings</h3>
                <ul class="ev-list ev-list-findings">
                    ${v.key_findings.map(f => `<li>${esc(f)}</li>`).join('')}
                </ul>
            </section>`);
        }
        if (Array.isArray(v.caveats) && v.caveats.length) {
            blocks.push(`
            <section class="ev-section">
                <h3><i class="fa-solid fa-circle-exclamation"></i> Caveats</h3>
                <ul class="ev-list ev-list-caveats">
                    ${v.caveats.map(c => `<li>${esc(c)}</li>`).join('')}
                </ul>
            </section>`);
        }
        return blocks.join('');
    }
})();
