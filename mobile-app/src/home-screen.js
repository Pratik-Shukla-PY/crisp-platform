// ──────────────────────────────────────────────────────────────────────────
// CRISP — Always-on home screen.
//
// Replaces landing.js (deleted May 2026). The first-visit-only landing
// overlay is gone — every visit lands on the same merged home page that
// surfaces:
//   • PWA "Start Reporting" (primary CTA, anonymous default)
//   • Live impact metrics (Lives Saved + Reports Verified)
//   • IVR / SMS / Telegram / WhatsApp deep-link buttons
//   • iOS / Android / Expo Go native-app buttons (with "Coming soon"
//     overlays where store URLs aren't yet available)
//   • PWA install prompt (when installable)
//   • One-time consent checkbox (auto-hidden after first accept)
//   • My Reports + Login / Sign-up secondary actions
//
// All this lives inside `#stage-home` (not an overlay), so tapping back /
// returning to the app always shows the same surface — no first-visit
// hide-once magic.
//
// Channel handles can be operator-overridden via `window.CRISP_CHANNELS`
// (set before this script loads). Defaults below ship with IVR + Telegram
// + Expo Go LIVE; SMS / WhatsApp / iOS / Android default to "Coming soon"
// until handles are wired.
//
// Behavioural contract:
//   • #btn-start (existing) is the primary CTA; we GATE its disabled
//     state on the consent checkbox until the user accepts. Once accepted,
//     consent persists in localStorage and the row hides on subsequent
//     loads.
//   • The existing app.js btn-start click handler (and v4-flow's capture-
//     phase intercept) stays untouched — we just preempt clicks when
//     consent isn't checked.
//   • applyI18n is called after channel buttons are inserted so every
//     [data-i18n] picks up the active locale.
// ──────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const CONSENT_KEY = 'crisp_privacy_consent';

    // ── Channel handles config ──────────────────────────────────────────
    // Operator overrides via `window.CRISP_CHANNELS` (set before this
    // script loads, e.g. from a server-rendered <script> block) take
    // precedence. Empty string → button rendered as "Coming soon" (greyed
    // out, no href). This lets us ship the surface today and wire real
    // numbers later without a redeploy of the static bundle.
    const DEFAULT_CHANNELS = {
        ivr_phone: '+16626768896',                              // LIVE — operator-confirmed
        sms_phone: '',                                          // Coming soon
        telegram_bot: 'crisp_undp_bot',                         // LIVE — https://t.me/crisp_undp_bot
        whatsapp_phone: '',                                     // Coming soon
        ios_app_url: '',                                        // Coming soon
        android_app_url: '',                                    // Coming soon
        expo_go_url: 'exp://exp.host/@crispundp/crisp-mobile',  // LIVE — testers / UNDP judges
    };
    const CHANNELS = Object.assign({}, DEFAULT_CHANNELS, window.CRISP_CHANNELS || {});

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

    // ── Consent helpers (matches landing.js's previous contract) ────────
    function _hasConsented() {
        try { return !!localStorage.getItem(CONSENT_KEY); } catch { return false; }
    }
    function _markConsent() {
        try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify({ accepted: true, ts: Date.now() }));
        } catch {}
    }

    // ── Channel button HTML builder ─────────────────────────────────────
    // May 2026 (UI v3 redesign Q1) — "Coming soon" placeholders removed.
    // Channels and native-app links render only when an actual URL is
    // configured. If a row ends up empty, the entire section (header +
    // wrapper) is hidden so the home page collapses cleanly. Saves
    // ~30% of vertical real estate above the fold under stress.
    function _buildChannelBtn(icon, label, href, key) {
        if (!href) return '';   // skip — was "Coming soon" before
        const targetAttr = (
            href.startsWith('tel:') || href.startsWith('sms:') || href.startsWith('exp:')
                ? ''
                : 'target="_blank" rel="noopener"'
        );
        return `
            <a class="home-channel"
               href="${href}" ${targetAttr}
               data-channel="${key}">
                <span class="lc-icon">${icon}</span>
                <span class="lc-label">${label}</span>
            </a>
        `;
    }

    function _renderChannels() {
        const channelsEl = document.getElementById('home-channels');
        if (channelsEl) {
            const html = [
                _buildChannelBtn('<i class="fa-solid fa-phone"></i>',
                                 'IVR call',
                                 _telLink(CHANNELS.ivr_phone), 'ivr'),
                _buildChannelBtn('<i class="fa-solid fa-comment-sms"></i>',
                                 'SMS',
                                 _smsLink(CHANNELS.sms_phone, 'CRISP help'), 'sms'),
                _buildChannelBtn('<i class="fa-brands fa-telegram"></i>',
                                 'Telegram',
                                 _telegramLink(CHANNELS.telegram_bot), 'telegram'),
                _buildChannelBtn('<i class="fa-brands fa-whatsapp"></i>',
                                 'WhatsApp',
                                 _whatsappLink(CHANNELS.whatsapp_phone, 'CRISP report'), 'whatsapp'),
            ].filter(Boolean).join('');
            channelsEl.innerHTML = html;
            // Hide the whole "Or report through:" section if no real channels.
            const channelsSection = channelsEl.closest('.home-section');
            if (channelsSection) channelsSection.style.display = html.trim() ? '' : 'none';
        }
        const appsEl = document.getElementById('home-apps');
        if (appsEl) {
            const html = [
                _buildChannelBtn('<i class="fa-brands fa-apple"></i>',
                                 'iOS', CHANNELS.ios_app_url, 'ios'),
                _buildChannelBtn('<i class="fa-brands fa-android"></i>',
                                 'Android', CHANNELS.android_app_url, 'android'),
                _buildChannelBtn('<i class="fa-solid fa-flask"></i>',
                                 'Expo Go', CHANNELS.expo_go_url, 'expo'),
            ].filter(Boolean).join('');
            appsEl.innerHTML = html;
            // Hide the whole "Get the app:" section if no real native apps.
            const appsSection = appsEl.closest('.home-section');
            if (appsSection) appsSection.style.display = html.trim() ? '' : 'none';
        }
    }

    // ── Consent gate ────────────────────────────────────────────────────
    function _wireConsent() {
        const consentRow = document.getElementById('home-consent');
        const consentCheck = document.getElementById('home-consent-check');
        const startBtn = document.getElementById('btn-start');
        if (!consentRow || !consentCheck || !startBtn) return;

        // Returning visitor (already consented) — hide the row, leave btn
        // enabled. Persists across sessions via localStorage.
        if (_hasConsented()) {
            consentRow.style.display = 'none';
            consentCheck.checked = true;
            startBtn.disabled = false;
            startBtn.classList.remove('is-locked');
            return;
        }

        // First-time visitor — gate Start until consent is checked.
        startBtn.disabled = true;
        startBtn.classList.add('is-locked');

        const _updateLock = () => {
            startBtn.disabled = !consentCheck.checked;
            startBtn.classList.toggle('is-locked', !consentCheck.checked);
            if (consentCheck.checked) {
                _markConsent();
                // Hide the consent row with a short fade so the user sees
                // their action persisted. Use display:none after 250ms so
                // the layout reclaims the space.
                consentRow.style.transition = 'opacity 0.2s ease';
                consentRow.style.opacity = '0';
                setTimeout(() => { consentRow.style.display = 'none'; }, 220);
            }
        };

        consentCheck.addEventListener('change', _updateLock);

        // Block btn-start clicks BEFORE app.js / v4-flow handlers run
        // (capture phase) when consent is missing. The handler also
        // animates a shake on the consent row to draw the eye.
        startBtn.addEventListener('click', (e) => {
            if (!consentCheck.checked) {
                e.preventDefault();
                e.stopImmediatePropagation();
                consentRow.classList.add('shake');
                setTimeout(() => consentRow.classList.remove('shake'), 400);
                consentCheck.focus();
            }
        }, true);   // capture: true — runs before bubble-phase listeners
    }

    // ── Install prompt (PWA Add-to-Home-Screen) ─────────────────────────
    function _wireInstallPrompt() {
        if (!window.InstallPrompt) return;
        const installBlock = document.getElementById('home-install');
        const installBtn = document.getElementById('home-install-btn');
        const installLabel = document.getElementById('home-install-label');
        if (!installBlock || !installBtn) return;

        window.InstallPrompt.onChange(({ canInstall, platform }) => {
            if (canInstall) {
                installBlock.style.display = '';
                if (installLabel) {
                    installLabel.textContent = platform === 'ios'
                        ? 'How to install on iPhone'
                        : 'Install on home screen';
                }
            } else {
                installBlock.style.display = 'none';
            }
        });
        installBtn.addEventListener('click', async () => {
            try { await window.InstallPrompt.show(); } catch (e) {
                console.warn('[home] install prompt failed:', e);
            }
        });
    }

    // ── Channel telemetry (best-effort, no-fail) ────────────────────────
    function _wireChannelTelemetry() {
        document.querySelectorAll('#home-channels [data-channel], #home-apps [data-channel]')
            .forEach((el) => {
                el.addEventListener('click', () => {
                    const key = el.getAttribute('data-channel');
                    console.log(`[home] channel tap: ${key}`);
                });
            });
    }

    // ── Init ────────────────────────────────────────────────────────────
    function init() {
        _renderChannels();
        _wireConsent();
        _wireInstallPrompt();
        _wireChannelTelemetry();
        // Re-apply i18n after we built the channel buttons — every
        // channel anchor carries `data-i18n="coming_soon"` on its badge,
        // and applyI18n() walks the whole tree.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) { console.warn('[home] i18n failed', e); }
        }
    }

    // Expose for tests + late re-init (locale change re-renders channels
    // for fresh translations).
    window.CrispHome = {
        init,
        renderChannels: _renderChannels,
        hasConsented: _hasConsented,
        markConsent: _markConsent,
        _channels: CHANNELS,  // for test inspection
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
