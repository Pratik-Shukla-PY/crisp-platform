// ──────────────────────────────────────────────────────────────────────────
// CRISP — First-visit landing card.
//
// Shown once per device (gated on `localStorage['crisp_landing_seen']`).
// Surfaces the multi-channel reporting surface UNDP requires:
//   • PWA reporter (primary)            → opens the existing capture flow
//   • IVR / SMS / Telegram / WhatsApp   → tel:/sms:/t.me/wa.me deep links
//   • iOS / Android native apps         → store URLs (or "Coming soon")
//   • Expo Go (advanced testers)        → preview the RN companion early
//   • PWA install prompt                → beforeinstallprompt or iOS Add-to-Home
//
// Also folds the legacy `#consent-overlay` into a single inline checkbox
// + Continue tap so first-visit users see ONE screen instead of two.
//
// Returning visitors skip this entirely — `_initLanding()` no-ops on
// subsequent loads.
//
// Non-goals:
//   - This file does NOT change the existing `#stage-home` or capture flow.
//     Once the landing dismisses, control hands off cleanly to the existing
//     navigation. v4 capture-flow changes ship in commit B.
// ──────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const LANDING_SEEN_KEY = 'crisp_landing_seen';
    const CONSENT_KEY = 'crisp_privacy_consent';

    // BUG 1 fix (May 2026) — landing page no longer fluctuates between
    // the home stage and the new landing card on first visit.
    //
    // Root cause: <div class="stage active" id="stage-home"> is parsed +
    // rendered before landing.js's DOMContentLoaded handler mounts the
    // overlay. On slow first paints (cold cache, 4G uplink, mid-range
    // device) the home screen flashes for 100-300ms before the landing
    // card drops on top — the user sees the OLD design briefly, then
    // the NEW one, hence "fluctuating".
    //
    // Fix: synchronously add `landing-pending` class to <body> the
    // moment this script executes (before DOMContentLoaded). CSS in
    // styles.css hides every .stage + #consent-overlay until the class
    // is removed. landing.js _dismiss + _shouldShow=false branch both
    // remove the class so legacy + returning users see no regression.
    function _shouldShowSync() {
        try {
            const seen = localStorage.getItem(LANDING_SEEN_KEY);
            const consent = localStorage.getItem(CONSENT_KEY);
            return !(seen && consent);
        } catch { return true; }
    }
    function _markPending() {
        try { document.documentElement.classList.add('landing-pending'); } catch (_) {}
        if (document.body) {
            document.body.classList.add('landing-pending');
        } else {
            // <body> not parsed yet — defer to the next microtask. Keeps
            // the html-level class present meanwhile so CSS selectors
            // targeting either work.
            queueMicrotask(() => {
                if (document.body) document.body.classList.add('landing-pending');
            });
        }
    }
    function _clearPending() {
        try { document.documentElement.classList.remove('landing-pending'); } catch (_) {}
        if (document.body) document.body.classList.remove('landing-pending');
    }
    if (_shouldShowSync()) _markPending();

    // ── Channel handles config ──────────────────────────────────────────
    // Operator overrides via `window.CRISP_CHANNELS` (set before this
    // script loads, e.g. from a server-rendered <script> block) take
    // precedence. Empty string → button rendered as "Coming soon" (greyed
    // out, no href). This lets us ship the surface today and wire real
    // numbers later without a redeploy of the static bundle.
    const DEFAULT_CHANNELS = {
        ivr_phone: '',                    // e.g. '+14155551234' → tel:+14155551234
        sms_phone: '',                    // e.g. '+14155551234' → sms:+14155551234
        telegram_bot: 'crisp_undp_bot',   // → https://t.me/crisp_undp_bot
        whatsapp_phone: '',               // e.g. '+14155551234' → https://wa.me/14155551234
        ios_app_url: '',                  // App Store URL or '' → "Coming soon"
        android_app_url: '',              // Play Store URL or '' → "Coming soon"
        expo_go_url: 'exp://exp.host/@crispundp/crisp-mobile',  // testers only
    };
    const CHANNELS = Object.assign({}, DEFAULT_CHANNELS, window.CRISP_CHANNELS || {});

    function _hasConsented() {
        try {
            return !!localStorage.getItem(CONSENT_KEY);
        } catch { return false; }
    }

    function _markLandingSeen() {
        try { localStorage.setItem(LANDING_SEEN_KEY, '1'); } catch {}
    }
    function _markConsent() {
        try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify({ accepted: true, ts: Date.now() }));
        } catch {}
    }

    function _shouldShow() {
        try {
            // Hide if already seen AND already consented. (If consent is
            // missing — e.g. user cleared site data after first visit —
            // we re-show the landing so we collect consent again.)
            if (localStorage.getItem(LANDING_SEEN_KEY) && _hasConsented()) return false;
        } catch { /* private browsing / storage disabled — default to showing */ }
        return true;
    }

    // ── Channel deep-link helpers ───────────────────────────────────────
    function _telLink(phone) {
        if (!phone) return '';
        return `tel:${phone.replace(/\s+/g, '')}`;
    }
    function _smsLink(phone, body) {
        if (!phone) return '';
        const cleaned = phone.replace(/\s+/g, '');
        const q = body ? `?body=${encodeURIComponent(body)}` : '';
        return `sms:${cleaned}${q}`;
    }
    function _telegramLink(handle) {
        if (!handle) return '';
        return `https://t.me/${handle.replace(/^@/, '')}`;
    }
    function _whatsappLink(phone, text) {
        if (!phone) return '';
        const cleaned = phone.replace(/[^0-9]/g, '');
        const q = text ? `?text=${encodeURIComponent(text)}` : '';
        return `https://wa.me/${cleaned}${q}`;
    }

    // ── Build the landing card DOM ──────────────────────────────────────
    function _buildCard() {
        const card = document.createElement('div');
        card.id = 'landing-overlay';
        card.className = 'landing-overlay';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'Welcome to CRISP');

        const ivrHref = _telLink(CHANNELS.ivr_phone);
        const smsHref = _smsLink(CHANNELS.sms_phone, 'CRISP help');
        const tgHref = _telegramLink(CHANNELS.telegram_bot);
        const waHref = _whatsappLink(CHANNELS.whatsapp_phone, 'CRISP report');

        // Channel button helper — disabled with "Coming soon" overlay
        // when the href is empty.
        const ch = (icon, label, href, key) => {
            const disabled = !href;
            const tag = disabled ? 'button' : 'a';
            const hrefAttr = disabled ? '' : `href="${href}"`;
            const targetAttr = disabled ? '' : (
                href.startsWith('tel:') || href.startsWith('sms:') ? '' : 'target="_blank" rel="noopener"'
            );
            return `
                <${tag} class="landing-channel ${disabled ? 'is-disabled' : ''}"
                        ${hrefAttr} ${targetAttr}
                        data-channel="${key}"
                        ${disabled ? 'aria-disabled="true" type="button"' : ''}>
                    <span class="lc-icon">${icon}</span>
                    <span class="lc-label">${label}</span>
                    ${disabled ? '<span class="lc-soon" data-i18n="coming_soon">Coming soon</span>' : ''}
                </${tag}>
            `;
        };

        const iosHref = CHANNELS.ios_app_url || '';
        const androidHref = CHANNELS.android_app_url || '';
        const expoHref = CHANNELS.expo_go_url || '';

        card.innerHTML = `
            <div class="landing-card">
                <header class="landing-header">
                    <div class="undp-badge">
                        <i class="fa-solid fa-satellite-dish"></i>
                        <span>CRISP × UNDP</span>
                    </div>
                    <h1 class="landing-title" data-i18n="landing_title">Report damage. Help responders.</h1>
                    <p class="landing-sub" data-i18n="landing_sub">
                        Quick, anonymous, works offline. Aligned with UNDP RAPIDA.
                    </p>
                </header>

                <!-- Live impact metrics — same source as the home screen.
                     Hidden on first ever load (no data yet); populated by
                     _paintHomeImpact() once the API responds. -->
                <div class="landing-impact" id="landing-impact" style="display:none;">
                    <div class="li-cell">
                        <div class="li-num" id="landing-lives-count">—</div>
                        <div class="li-label" data-i18n="home_metric_lives">Lives Saved</div>
                    </div>
                    <div class="li-divider"></div>
                    <div class="li-cell">
                        <div class="li-num" id="landing-verified-count">—</div>
                        <div class="li-label" data-i18n="home_metric_verified">Reports Verified</div>
                    </div>
                </div>

                <button class="landing-primary" id="landing-start-btn" type="button">
                    <i class="fa-solid fa-camera"></i>
                    <span data-i18n="landing_open_reporter">Open the reporter</span>
                </button>

                <div class="landing-section">
                    <div class="landing-section-title" data-i18n="landing_other_channels">
                        Or report through:
                    </div>
                    <div class="landing-channels">
                        ${ch('<i class="fa-solid fa-phone"></i>',  'IVR call', ivrHref, 'ivr')}
                        ${ch('<i class="fa-solid fa-comment-sms"></i>', 'SMS', smsHref, 'sms')}
                        ${ch('<i class="fa-brands fa-telegram"></i>',   'Telegram', tgHref, 'telegram')}
                        ${ch('<i class="fa-brands fa-whatsapp"></i>',   'WhatsApp', waHref, 'whatsapp')}
                    </div>
                </div>

                <div class="landing-section">
                    <div class="landing-section-title" data-i18n="landing_get_app">
                        Get the app:
                    </div>
                    <div class="landing-apps">
                        ${ch('<i class="fa-brands fa-apple"></i>',  'iOS', iosHref, 'ios')}
                        ${ch('<i class="fa-brands fa-android"></i>','Android', androidHref, 'android')}
                        ${ch('<i class="fa-solid fa-flask"></i>',   'Expo Go (testers)', expoHref, 'expo')}
                    </div>
                </div>

                <!-- PWA install prompt slot — populated reactively by
                     InstallPrompt.onChange(). Hidden when not installable
                     (e.g. already installed → display-mode standalone). -->
                <div class="landing-install" id="landing-install" style="display:none;">
                    <button class="landing-install-btn" id="landing-install-btn" type="button">
                        <i class="fa-solid fa-mobile-screen-button"></i>
                        <span id="landing-install-label" data-i18n="landing_install_pwa">
                            Install on home screen
                        </span>
                    </button>
                </div>

                <div class="landing-consent">
                    <label class="landing-consent-row">
                        <input type="checkbox" id="landing-consent-check">
                        <span data-i18n="landing_consent">
                            I consent to share my report data with crisis responders.
                        </span>
                    </label>
                </div>

                <div class="landing-secondary-row">
                    <button class="landing-secondary-btn" id="landing-my-reports" type="button">
                        <i class="fa-solid fa-clipboard-list"></i>
                        <span data-i18n="my_reports">My Reports</span>
                    </button>
                    <button class="landing-secondary-btn" id="landing-login" type="button">
                        <i class="fa-solid fa-right-to-bracket"></i>
                        <span data-i18n="login_or_signup">Login</span>
                    </button>
                </div>

                <footer class="landing-footer">
                    <span data-i18n="landing_offline_hint">
                        Works offline · Open-source · UNDP-aligned
                    </span>
                </footer>
            </div>
        `;
        return card;
    }

    function _wireCard(card) {
        const startBtn = card.querySelector('#landing-start-btn');
        const consentCheck = card.querySelector('#landing-consent-check');
        const installBlock = card.querySelector('#landing-install');
        const installBtn = card.querySelector('#landing-install-btn');
        const installLabel = card.querySelector('#landing-install-label');
        const myReportsBtn = card.querySelector('#landing-my-reports');
        const loginBtn = card.querySelector('#landing-login');

        // Pre-check consent if user already consented in a prior visit
        // (e.g. they cleared the landing flag but kept consent).
        if (_hasConsented()) {
            consentCheck.checked = true;
        }

        const _updateStartEnabled = () => {
            const ready = consentCheck.checked;
            startBtn.disabled = !ready;
            startBtn.classList.toggle('is-ready', ready);
        };
        _updateStartEnabled();
        consentCheck.addEventListener('change', _updateStartEnabled);

        const _dismiss = () => {
            _markLandingSeen();
            if (consentCheck.checked) _markConsent();
            card.classList.add('is-leaving');
            // BUG 1 fix — clear the landing-pending class on dismiss so
            // the home stage / consent overlay become visible.
            _clearPending();
            setTimeout(() => card.remove(), 250);
        };

        startBtn.addEventListener('click', () => {
            if (!consentCheck.checked) {
                consentCheck.focus();
                consentCheck.parentElement.classList.add('shake');
                setTimeout(() => consentCheck.parentElement.classList.remove('shake'), 400);
                return;
            }
            _dismiss();
            // Hand off to existing flow — `goToStage` is exposed on window
            // by app.js for exactly this kind of cross-module navigation.
            // Defer one tick so the DOM removal animation can begin.
            setTimeout(() => {
                if (typeof window.goToStage === 'function') {
                    window.goToStage('stage-home');
                    // Then trigger the start button if the user explicitly
                    // chose "Open the reporter" — the existing handler
                    // hooks all the per-stage init we'd otherwise duplicate.
                    const btnStart = document.getElementById('btn-start');
                    if (btnStart) btnStart.click();
                }
            }, 50);
        });

        // My Reports / Login route to existing handlers — same UX as home.
        myReportsBtn.addEventListener('click', () => {
            _dismiss();
            setTimeout(() => {
                const btn = document.getElementById('btn-my-reports');
                if (btn) btn.click();
                else if (typeof window.goToStage === 'function') window.goToStage('stage-history');
            }, 50);
        });

        loginBtn.addEventListener('click', () => {
            _dismiss();
            setTimeout(() => {
                const btn = document.getElementById('btn-login');
                if (btn) btn.click();
            }, 50);
        });

        // Install button — reactively shown when InstallPrompt says so.
        if (window.InstallPrompt) {
            const _onInstallChange = ({ canInstall, platform }) => {
                if (canInstall) {
                    installBlock.style.display = '';
                    if (platform === 'ios') {
                        installLabel.textContent = 'How to install on iPhone';
                    } else {
                        installLabel.textContent = 'Install on home screen';
                    }
                } else {
                    installBlock.style.display = 'none';
                }
            };
            window.InstallPrompt.onChange(_onInstallChange);
            installBtn.addEventListener('click', async () => {
                await window.InstallPrompt.show();
            });
        }

        // Channel deep-link tap telemetry (best-effort, no fail).
        card.querySelectorAll('[data-channel]').forEach((el) => {
            el.addEventListener('click', () => {
                const ch = el.getAttribute('data-channel');
                console.log(`[Landing] channel tap: ${ch}`);
                // If the channel is interactive (anchor) and dismisses
                // landing, set the seen flag so the user comes back to
                // home next time. Don't dismiss for "Coming soon" buttons.
                if (el.tagName === 'A') {
                    _markLandingSeen();
                    if (consentCheck.checked) _markConsent();
                }
            });
        });
    }

    // ── Public init ─────────────────────────────────────────────────────
    function init() {
        if (!_shouldShow()) {
            // Returning visitor — clear the pending class immediately so
            // stage-home / etc. become visible without waiting for any
            // dismissal animation.
            _clearPending();
            return false;
        }

        const root = document.getElementById('landing-root') || document.body;
        const card = _buildCard();
        root.appendChild(card);
        _wireCard(card);

        // Re-apply i18n if the helper exists. App.js's applyI18n() walks
        // the DOM looking for [data-i18n] attributes; we just inserted
        // a tree full of them.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) { console.warn('[Landing] i18n failed', e); }
        }

        return true;
    }

    // Suppress the existing consent overlay if the landing card is going
    // to handle it. Belt-and-braces — `_initConsentGate()` in app.js
    // already early-returns if CONSENT_KEY exists; this just ensures the
    // overlay element never flashes visibly while landing is mounting.
    function _suppressLegacyConsentOverlay() {
        const overlay = document.getElementById('consent-overlay');
        if (overlay && _shouldShow()) {
            // Keep it hidden — landing card will collect consent inline.
            overlay.style.display = 'none';
        }
    }

    window.CrispLanding = { init, _shouldShow };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            _suppressLegacyConsentOverlay();
            init();
        });
    } else {
        _suppressLegacyConsentOverlay();
        init();
    }
})();
