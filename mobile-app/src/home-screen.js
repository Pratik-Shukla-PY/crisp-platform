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

    // ── Channel tile HTML builder ───────────────────────────────────────
    // Phase 17 (May 2026) — every channel always renders. Working
    // channels (href set) get a green border + brand-coloured icon + a
    // small green "live" pip. Non-working channels (empty href) get a
    // grey border + grey icon + cursor:not-allowed. Tapping a non-
    // working tile fires a brief "Coming soon" toast.
    //
    // The Q1 (May 2026) hide-when-empty contract is REVERTED here per
    // explicit product direction — users want to see the full picture
    // of which channels exist, not just the ones currently configured.
    function _buildChannelTile(icon, label, href, key, colorVar) {
        const safeLabel = String(label).replace(/"/g, '&quot;');
        const safeColor = colorVar || '--accent';
        if (!href) {
            // Non-working tile — grey border, grey icon, button (not
            // anchor), tap → toast.
            return `
                <button type="button" class="home-channel-tile is-disabled"
                        data-channel="${key}"
                        aria-label="${safeLabel} — coming soon"
                        aria-disabled="true">
                    <span class="ct-icon" aria-hidden="true">${icon}</span>
                    <span class="ct-label">${label}</span>
                </button>
            `;
        }
        const targetAttr = (
            href.startsWith('tel:') || href.startsWith('sms:') || href.startsWith('exp:')
                ? ''
                : 'target="_blank" rel="noopener"'
        );
        const safeHref = String(href).replace(/"/g, '&quot;');
        return `
            <a class="home-channel-tile is-live"
               style="--c: var(${safeColor});"
               href="${safeHref}" ${targetAttr}
               data-channel="${key}"
               aria-label="${safeLabel}">
                <span class="ct-icon" aria-hidden="true">${icon}</span>
                <span class="ct-label">${label}</span>
                <span class="ct-dot" aria-hidden="true" title="Available"></span>
            </a>
        `;
    }

    function _renderChannels() {
        const channelsEl = document.getElementById('home-channels');
        if (channelsEl) {
            // Phase 17 — Single 6-tile row, all channels always shown.
            // Order matches the proposal screenshot: Telegram, WhatsApp,
            // SMS, IVR, Android, iOS (left to right).
            const html = [
                _buildChannelTile('<i class="fa-brands fa-telegram"></i>',
                                  'Telegram',
                                  _telegramLink(CHANNELS.telegram_bot), 'telegram',
                                  '--brand-telegram'),
                _buildChannelTile('<i class="fa-brands fa-whatsapp"></i>',
                                  'WhatsApp',
                                  _whatsappLink(CHANNELS.whatsapp_phone, 'CRISP report'), 'whatsapp',
                                  '--brand-whatsapp'),
                _buildChannelTile('<i class="fa-solid fa-message"></i>',
                                  'SMS',
                                  _smsLink(CHANNELS.sms_phone, 'CRISP help'), 'sms',
                                  '--brand-sms'),
                _buildChannelTile('<i class="fa-solid fa-phone-volume"></i>',
                                  'IVR',
                                  _telLink(CHANNELS.ivr_phone), 'ivr',
                                  '--brand-ivr'),
                _buildChannelTile('<i class="fa-brands fa-android"></i>',
                                  'Android', CHANNELS.android_app_url, 'android',
                                  '--good'),
                _buildChannelTile('<i class="fa-brands fa-apple"></i>',
                                  'iOS', CHANNELS.ios_app_url, 'ios',
                                  '--brand-ios'),
            ].join('');
            channelsEl.innerHTML = html;
            // Section ALWAYS visible (Phase-17 contract change).
            const channelsSection = channelsEl.closest('.home-section');
            if (channelsSection) channelsSection.style.display = '';
        }
        // Phase 17 — #home-apps is now hidden in the markup; we
        // intentionally don't render into it. Kept as a no-op so any
        // operator override that still references it doesn't blow up.
        const appsEl = document.getElementById('home-apps');
        if (appsEl) {
            appsEl.innerHTML = '';
        }
    }

    // Phase 17 — brief in-place toast for "coming soon" channel taps.
    // No external dep; just appends a fixed-position div the user can
    // tap-anywhere to dismiss or which fades out after 2.6 s.
    function _showComingSoonToast(channelLabel) {
        const tt = (typeof window.t === 'function') ? window.t : (k, f) => f || k;
        const msg = tt('home_channel_coming_soon', `${channelLabel} coming soon`)
            .replace('{ch}', channelLabel);
        // Cap one toast on screen at a time.
        const old = document.querySelector('.home-channel-toast');
        if (old) old.remove();
        const el = document.createElement('div');
        el.className = 'home-channel-toast';
        el.setAttribute('role', 'status');
        el.textContent = msg;
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('is-visible'));
        const dismiss = () => {
            el.classList.remove('is-visible');
            setTimeout(() => el.remove(), 250);
        };
        setTimeout(dismiss, 2600);
        el.addEventListener('click', dismiss);
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

    // ── Channel telemetry + disabled-tile toast ────────────────────────
    // Phase 17 — non-working (`.is-disabled`) tiles surface a brief
    // "Coming soon" toast on click. Working tiles just log a telemetry
    // breadcrumb and let the browser follow the anchor href.
    function _wireChannelTelemetry() {
        document.querySelectorAll('#home-channels [data-channel], #home-apps [data-channel]')
            .forEach((el) => {
                el.addEventListener('click', (e) => {
                    const key = el.getAttribute('data-channel');
                    if (el.classList.contains('is-disabled')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const labelEl = el.querySelector('.ct-label');
                        const label = labelEl ? labelEl.textContent.trim() : key;
                        _showComingSoonToast(label);
                        return;
                    }
                    console.log(`[home] channel tap: ${key}`);
                });
            });
    }

    // ── Phase 15 — Identity bar + account dropdown + device-ID badge ────
    //
    // The home identity bar has two slots: anonymous users see a
    // device-ID badge (CRISP-XXXX-XXXX with copy + info buttons);
    // logged-in users see an account pill + dropdown menu. We swap
    // visibility on every `auth-changed` / `auth-ready` event.
    //
    // Backwards-compat: legacy users with `crisp_welcome_acknowledged`
    // are treated as having seen the device-ID tooltip (so they don't
    // get re-prompted). The tooltip auto-shows ONCE for net-new users,
    // then sets `crisp_homedevid_tip_seen` in localStorage.
    const TIP_SEEN_KEY = 'crisp_homedevid_tip_seen';
    const LEGACY_WELCOME_KEY = 'crisp_welcome_acknowledged';

    function _hasSeenDevidTip() {
        try {
            return !!(localStorage.getItem(TIP_SEEN_KEY) || localStorage.getItem(LEGACY_WELCOME_KEY));
        } catch { return true; }      // pessimistic — don't auto-popup if storage broken
    }
    function _markDevidTipSeen() {
        try { localStorage.setItem(TIP_SEEN_KEY, '1'); } catch {}
    }

    function _paintDevidBadge() {
        const text = document.getElementById('home-devid-text');
        if (!text) return;
        // Try app.js helper first (formatted CRISP-XXXX-XXXX); fall back
        // to a placeholder while the device-ID generator runs.
        let formatted = '';
        try {
            if (typeof window._formatDeviceIdForDisplay === 'function') {
                const raw = (function () {
                    try { return localStorage.getItem('crisp_device_id_v2') || ''; }
                    catch { return ''; }
                })();
                if (raw) formatted = window._formatDeviceIdForDisplay(raw);
            }
        } catch (_) {}
        text.textContent = formatted || 'CRISP-····-····';
    }

    function _wireDevidBadge() {
        const badge = document.getElementById('home-devid-badge');
        const copyBtn = document.getElementById('btn-home-devid-copy');
        const infoBtn = document.getElementById('btn-home-devid-info');
        const tip = document.getElementById('home-devid-tip');
        const tipDismiss = document.getElementById('btn-home-devid-tip-dismiss');
        if (!badge) return;

        _paintDevidBadge();

        // Copy → clipboard with brief visual confirmation.
        if (copyBtn) {
            copyBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const txt = (document.getElementById('home-devid-text') || {}).textContent || '';
                try {
                    await (navigator.clipboard && navigator.clipboard.writeText
                        ? navigator.clipboard.writeText(txt)
                        : Promise.reject(new Error('no clipboard')));
                    badge.classList.add('is-copied');
                    setTimeout(() => badge.classList.remove('is-copied'), 1400);
                } catch (_) {
                    // Fallback: prompt the user to copy manually.
                    try { window.prompt('Copy your reporter ID', txt); } catch {}
                }
            });
        }

        // Info → toggle the tooltip (also dismissed on outside-click).
        function _showTip() {
            if (!tip) return;
            tip.removeAttribute('hidden');
            if (infoBtn) infoBtn.setAttribute('aria-expanded', 'true');
        }
        function _hideTip() {
            if (!tip) return;
            tip.setAttribute('hidden', '');
            if (infoBtn) infoBtn.setAttribute('aria-expanded', 'false');
            _markDevidTipSeen();
        }
        if (infoBtn) {
            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (tip && tip.hasAttribute('hidden')) _showTip(); else _hideTip();
            });
        }
        if (tipDismiss) tipDismiss.addEventListener('click', _hideTip);
        document.addEventListener('click', (e) => {
            if (!tip || tip.hasAttribute('hidden')) return;
            if (tip.contains(e.target) || (infoBtn && infoBtn.contains(e.target))) return;
            _hideTip();
        });

        // Auto-show tooltip ONCE for net-new users. Defer 1500ms so it
        // doesn't compete with first-paint perception.
        if (!_hasSeenDevidTip()) {
            setTimeout(() => {
                // Don't auto-show if user is already logged in (different
                // identity slot) or if the tip was meanwhile dismissed.
                if (!_isLoggedIn() && tip && tip.hasAttribute('hidden')) {
                    _showTip();
                    // Auto-dismiss after 8s — flag as seen.
                    setTimeout(() => {
                        if (!tip.hasAttribute('hidden')) _hideTip();
                    }, 8000);
                }
            }, 1500);
        }

        // Repaint the badge whenever the device-ID resolves later (race
        // between paint and async _generateDeviceIdIfMissing).
        document.addEventListener('crisp-deviceid-ready', _paintDevidBadge);
    }

    function _isLoggedIn() {
        try { return !!(window.AuthStore && window.AuthStore.isLoggedIn && window.AuthStore.isLoggedIn()); }
        catch { return false; }
    }

    function _wireAccountMenu() {
        const wrap = document.getElementById('home-account-wrap');
        const pill = document.getElementById('account-pill');
        const dropTrigger = document.getElementById('btn-account-settings');
        const menu = document.getElementById('home-account-menu');
        const myReportsBtn = document.getElementById('btn-home-menu-myreports');
        const settingsBtn = document.getElementById('btn-home-menu-settings');
        const logoutBtn = document.getElementById('btn-home-menu-logout');
        if (!wrap || !menu) return;

        function _toggle(force) {
            const willOpen = (force === undefined)
                ? menu.hasAttribute('hidden')
                : !!force;
            if (willOpen) {
                menu.removeAttribute('hidden');
                if (pill) pill.setAttribute('aria-expanded', 'true');
            } else {
                menu.setAttribute('hidden', '');
                if (pill) pill.setAttribute('aria-expanded', 'false');
            }
        }

        // Both the gear icon and the entire pill row open the menu.
        if (dropTrigger) dropTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            _toggle();
        });
        if (pill) pill.addEventListener('click', (e) => {
            // Only the pill body — the gear has its own handler above.
            if (e.target.closest('#btn-account-settings')) return;
            _toggle();
        });
        // Outside-click dismisses.
        document.addEventListener('click', (e) => {
            if (menu.hasAttribute('hidden')) return;
            if (wrap.contains(e.target)) return;
            _toggle(false);
        });
        // Esc closes.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.hasAttribute('hidden')) _toggle(false);
        });

        if (myReportsBtn) myReportsBtn.addEventListener('click', () => {
            _toggle(false);
            if (typeof window.openMyReports === 'function') window.openMyReports();
            else if (typeof window.goToStage === 'function') window.goToStage('stage-history');
        });
        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            _toggle(false);
            if (typeof window.goToStage === 'function') window.goToStage('stage-settings');
        });
        if (logoutBtn) logoutBtn.addEventListener('click', async () => {
            _toggle(false);
            try {
                if (window.AuthStore && window.AuthStore.logout) await window.AuthStore.logout();
            } catch (_) {
                // logout() already calls logoutLocal() on server failure.
            }
            // paintIdentityBar() will run on auth-changed event.
        });
    }

    function _paintIdentityBar() {
        const devidWrap = document.getElementById('home-devid-wrap');
        const acctWrap = document.getElementById('home-account-wrap');
        const acctName = document.getElementById('account-name');
        const subEl = document.getElementById('home-title-sub');
        const myReportsBtn = document.getElementById('btn-my-reports');
        const loginBtn = document.getElementById('btn-login');
        const recentBlock = document.getElementById('home-recent');
        if (!devidWrap || !acctWrap) return;

        const loggedIn = _isLoggedIn();
        if (loggedIn) {
            devidWrap.setAttribute('hidden', '');
            acctWrap.removeAttribute('hidden');
            // Account name from AuthStore.
            try {
                const u = window.AuthStore.getUser && window.AuthStore.getUser();
                if (u && acctName) {
                    acctName.textContent = u.displayName || u.id || '—';
                }
            } catch (_) {}
            // Phase 18 — supratext above the CTA reads "Welcome back, {name}."
            if (subEl) {
                const tt = (typeof window.t === 'function') ? window.t : (k) => k;
                const u = (window.AuthStore && window.AuthStore.getUser && window.AuthStore.getUser()) || {};
                const name = (u.displayName || '').split(/\s+/)[0] || '';
                const tmpl = tt('home_greeting_loggedin') || 'Welcome back, {name}.';
                subEl.textContent = name ? tmpl.replace('{name}', name) : '';
                if (name) subEl.removeAttribute('hidden'); else subEl.setAttribute('hidden', '');
            }
            // Hide bottom secondary row buttons (My Reports + Login lives in dropdown).
            if (myReportsBtn) myReportsBtn.style.display = 'none';
            if (loginBtn) loginBtn.style.display = 'none';
            // Show recent-reports block (will populate async).
            if (recentBlock) recentBlock.removeAttribute('hidden');
            _renderRecentReports();
        } else {
            acctWrap.setAttribute('hidden', '');
            devidWrap.removeAttribute('hidden');
            if (subEl) subEl.setAttribute('hidden', '');
            // Restore bottom secondary row.
            if (myReportsBtn) myReportsBtn.style.display = '';
            if (loginBtn) loginBtn.style.display = '';
            // Hide recent-reports block.
            if (recentBlock) recentBlock.setAttribute('hidden', '');
        }
        // Phase 18 — repaint badge chip + My Reports count for both states.
        try { _renderBadgeChip(); } catch (_) {}
        try { _renderMyReportsCount(); } catch (_) {}
    }

    // ── Phase 18 — badge chip + My Reports count + voice + install ────
    //
    // Badge chip: fetches `/api/v1/reports/profile/<device-hash>` once on
    // home init + on each repaint. Maps `badge_level` to emoji + label
    // (5 tiers: NEWCOMER / HELPER / GUARDIAN / CHAMPION / HERO).
    // sessionStorage caches the last result for instant paint.
    const BADGE_LEVELS = {
        NEWCOMER:  { emoji: '🌱', cls: 'lvl-newcomer',  i18nKey: 'home_badge_newcomer'  },
        HELPER:    { emoji: '⛑',  cls: 'lvl-helper',    i18nKey: 'home_badge_helper'    },
        GUARDIAN:  { emoji: '🛡', cls: 'lvl-guardian',  i18nKey: 'home_badge_guardian'  },
        CHAMPION:  { emoji: '⭐', cls: 'lvl-champion',  i18nKey: 'home_badge_champion'  },
        HERO:      { emoji: '🏆', cls: 'lvl-hero',      i18nKey: 'home_badge_hero'      },
    };
    const BADGE_CACHE_KEY = 'crisp_home_badge_v1';
    function _readBadgeCache() {
        try { return JSON.parse(sessionStorage.getItem(BADGE_CACHE_KEY) || 'null'); } catch { return null; }
    }
    function _writeBadgeCache(level) {
        try { sessionStorage.setItem(BADGE_CACHE_KEY, JSON.stringify(level || null)); } catch {}
    }
    function _paintBadgeChip(level) {
        const chip = document.getElementById('home-badge-chip');
        const emojiEl = document.getElementById('home-badge-emoji');
        const labelEl = document.getElementById('home-badge-label');
        if (!chip || !emojiEl || !labelEl) return;
        const def = BADGE_LEVELS[String(level || '').toUpperCase()] || BADGE_LEVELS.NEWCOMER;
        emojiEl.textContent = def.emoji;
        // Phase 18 — `window.t(key)` returns the KEY itself when not yet
        // resolved (en.json loads async). Treat key === t(key) as
        // "not resolved" and fall back to a sensible English default.
        const ENGLISH_FALLBACKS = {
            'home_badge_newcomer': 'Newcomer',
            'home_badge_helper':   'Helper',
            'home_badge_guardian': 'Guardian',
            'home_badge_champion': 'Champion',
            'home_badge_hero':     'Hero',
        };
        let labelText = ENGLISH_FALLBACKS[def.i18nKey] || 'Newcomer';
        if (typeof window.t === 'function') {
            const t = window.t(def.i18nKey);
            if (t && t !== def.i18nKey) labelText = t;
        }
        labelEl.textContent = labelText;
        // Reset level classes then add the active one.
        Object.values(BADGE_LEVELS).forEach((d) => chip.classList.remove(d.cls));
        chip.classList.add(def.cls);
        chip.removeAttribute('hidden');
    }
    async function _renderBadgeChip() {
        const chip = document.getElementById('home-badge-chip');
        if (!chip) return;
        // Optimistic paint from cache.
        const cached = _readBadgeCache();
        if (cached) _paintBadgeChip(cached);
        // Fetch fresh.
        let hash = '';
        try {
            hash = localStorage.getItem('crisp_device_id_v2')
                || localStorage.getItem('crisp_device_hash')
                || localStorage.getItem('crisp_device_id') || '';
        } catch (_) {}
        if (!hash) {
            // No device hash yet — default to NEWCOMER so the chip still
            // shows something meaningful on first paint.
            if (!cached) _paintBadgeChip('NEWCOMER');
            return;
        }
        try {
            const apiBase = window.API_BASE || '/api/v1';
            const res = await fetch(`${apiBase}/reports/profile/${encodeURIComponent(hash)}`);
            if (!res.ok) return;
            const p = await res.json();
            const lvl = String(p.badge_level || 'NEWCOMER').toUpperCase();
            _paintBadgeChip(lvl);
            _writeBadgeCache(lvl);
        } catch (_) {
            // Network error — fall back to cached or NEWCOMER. Never
            // hide the chip; "Newcomer" is the honest default.
            if (!cached) _paintBadgeChip('NEWCOMER');
        }
    }

    // My Reports (X) count — counts local cache + in-flight queue.
    function _renderMyReportsCount() {
        const span = document.getElementById('mr-count');
        if (!span) return;
        let count = 0;
        try {
            // _submittedCache lives in app.js scope. Use the global lookup
            // if exposed, otherwise count the rendered list as a fallback.
            if (Array.isArray(window._submittedCache)) {
                count = window._submittedCache.length;
            }
        } catch (_) {}
        if (count > 0) {
            span.textContent = `(${count})`;
            span.removeAttribute('hidden');
        } else {
            span.setAttribute('hidden', '');
        }
    }

    // PWA install icon — always visible until `display-mode: standalone`
    // matches (i.e. the app has been added to home screen).
    function _wireInstallIcon() {
        const btn = document.getElementById('btn-home-install-icon');
        if (!btn) return;
        function refresh() {
            // If we're already standalone (installed), hide the icon.
            const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                || window.navigator.standalone === true;
            if (standalone) { btn.setAttribute('hidden', ''); return; }
            // Otherwise show — InstallPrompt.show() figures out the right
            // path (Chrome native vs iOS sheet) at click time.
            btn.removeAttribute('hidden');
        }
        refresh();
        if (window.matchMedia) {
            window.matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);
        }
        btn.addEventListener('click', async () => {
            try {
                if (window.InstallPrompt && window.InstallPrompt.show) {
                    await window.InstallPrompt.show();
                } else {
                    // Surface the existing iOS / fallback sheet.
                    const fallback = document.getElementById('home-install');
                    if (fallback) {
                        fallback.style.display = '';
                        fallback.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }
            } catch (e) {
                console.warn('[home] install icon failed:', e);
            }
        });
    }

    // Voice readout — top-bar 🔊 button. Reads aloud the current
    // home content in the active language. UNDP rubric Q3.
    function _wireHomeVoice() {
        const btn = document.getElementById('btn-home-voice');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const tt = (typeof window.t === 'function') ? window.t : (k, f) => f || k;
            const parts = [
                'CRISP',
                tt('home_cta_primary', 'Report an Incident'),
                tt('home_voice_hint', 'Tap the orange button to start. Or use Telegram, WhatsApp, SMS, or a phone call.'),
            ];
            const text = parts.join('. ');
            try {
                if (window.VoiceReadout && window.VoiceReadout.speak) {
                    btn.classList.add('is-speaking');
                    window.VoiceReadout.speak(text);
                    // The speak() implementation in voice-readout.js cancels
                    // on next call; we leave the visual state on for a few
                    // seconds then auto-clear.
                    setTimeout(() => btn.classList.remove('is-speaking'), 6000);
                }
            } catch (e) {
                console.warn('[home] voice readout failed:', e);
                btn.classList.remove('is-speaking');
            }
        });
    }

    // Utility-footer + safety-hint navigation.
    function _wireUtilityFooter() {
        const privacy = document.getElementById('btn-home-privacy');
        const help = document.getElementById('btn-home-help');
        if (privacy) privacy.addEventListener('click', () => {
            if (typeof window.goToStage === 'function') window.goToStage('stage-privacy');
        });
        if (help) help.addEventListener('click', () => {
            if (typeof window.goToStage === 'function') window.goToStage('stage-privacy');
            // Scroll to the "How it works" section after a beat.
            setTimeout(() => {
                const t = document.getElementById('privacy-how-it-works');
                if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 250);
        });
        // Settings → Privacy & features button.
        const settingsPrivacy = document.getElementById('btn-settings-privacy');
        if (settingsPrivacy) settingsPrivacy.addEventListener('click', () => {
            if (typeof window.goToStage === 'function') window.goToStage('stage-privacy');
        });
        // Stage-privacy back button.
        const back = document.getElementById('btn-privacy-back');
        if (back) back.addEventListener('click', () => {
            if (typeof window.goToStage === 'function') window.goToStage('stage-home');
        });
    }

    // ── Recent-reports (logged-in only) ────────────────────────────────
    // Up to 3 most-recent cards. Tries AuthStore.meReports() first
    // (server-side aggregated, includes anonymous reports linked to
    // the account), falls back to /reports/device/{hash}/status-since
    // when meReports() 401s, is offline, or returns < 3. Cached in
    // sessionStorage for instant paint on return.
    const RECENT_CACHE_KEY = 'crisp_home_recent_v1';
    function _readRecentCache() {
        try {
            const raw = sessionStorage.getItem(RECENT_CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function _writeRecentCache(arr) {
        try { sessionStorage.setItem(RECENT_CACHE_KEY, JSON.stringify(arr)); } catch {}
    }
    async function _fetchRecentReports() {
        // Logged-in path — meReports.
        if (_isLoggedIn() && window.AuthStore && window.AuthStore.meReports) {
            try {
                const r = await window.AuthStore.meReports();
                if (Array.isArray(r) && r.length) return r;
            } catch (_) { /* fall through */ }
        }
        // Device-hash fallback.
        try {
            const hash = (function () {
                try {
                    return localStorage.getItem('crisp_device_id_v2')
                        || localStorage.getItem('crisp_device_hash')
                        || localStorage.getItem('crisp_device_id') || '';
                } catch { return ''; }
            })();
            if (!hash) return [];
            const apiBase = window.API_BASE || '/api/v1';
            const res = await fetch(`${apiBase}/reports/device/${encodeURIComponent(hash)}/status-since?since=1970-01-01T00:00:00Z`);
            if (!res.ok) return [];
            const arr = await res.json();
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }
    function _renderRecentList(reports) {
        const listEl = document.getElementById('home-recent-list');
        if (!listEl) return;
        if (!reports || !reports.length) {
            const tt = (typeof window.t === 'function') ? window.t : (k) => k;
            listEl.innerHTML = `<div class="home-recent-empty">${tt('home_recent_reports_empty') || 'No reports yet.'}</div>`;
            return;
        }
        const top3 = reports
            .slice()
            .sort((a, b) => {
                const ta = new Date(a.server_created_at || a.updated_at || 0).getTime();
                const tb = new Date(b.server_created_at || b.updated_at || 0).getTime();
                return tb - ta;
            })
            .slice(0, 3);
        listEl.innerHTML = top3.map((r) => {
            const id = r.id || r.client_report_id || '';
            const loc = (r.location && (r.location.user_location_name || r.location.device_location_name)) || '';
            const when = (function () {
                if (typeof window._timeAgo === 'function') {
                    try { return window._timeAgo(r.server_created_at || r.updated_at) || ''; }
                    catch { return ''; }
                }
                return '';
            })();
            const status = String(r.status || 'PENDING').toLowerCase();
            // Phase 16 — route through window._resolveMediaUrl so any
            // future s3:// regression surfaces a placeholder cleanly.
            // onerror handler swaps the broken <img> for the camera
            // icon (matches the card-thumb pattern in app.js).
            const thumbUrl = (typeof window._resolveMediaUrl === 'function')
                ? window._resolveMediaUrl(r.thumbnail_url)
                : (r.thumbnail_url || '');
            const thumb = thumbUrl
                ? `<img src="${thumbUrl}" alt="" loading="lazy"
                        onerror="this.outerHTML='<i class=&quot;fa-solid fa-camera&quot; aria-hidden=&quot;true&quot;></i>'">`
                : `<i class="fa-solid fa-camera" aria-hidden="true"></i>`;
            const escape = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            }[c]));
            return `<button class="home-recent-card" type="button" data-report-id="${escape(id)}">
                <div class="home-recent-thumb">${thumb}</div>
                <div class="home-recent-body">
                    <div class="home-recent-title-row">
                        <span class="home-recent-loc">${escape(loc) || '—'}</span>
                        <span class="home-recent-when">${escape(when)}</span>
                    </div>
                    <span class="home-recent-status">${escape(status)}</span>
                </div>
            </button>`;
        }).join('');
        // Wire click → open detail
        listEl.querySelectorAll('.home-recent-card').forEach((el) => {
            el.addEventListener('click', () => {
                const id = el.getAttribute('data-report-id');
                if (id && typeof window.openReportDetail === 'function') {
                    window.openReportDetail(id);
                }
            });
        });
    }
    async function _renderRecentReports() {
        // Optimistic paint from cache.
        const cached = _readRecentCache();
        if (cached) _renderRecentList(cached);
        // Refresh.
        const fresh = await _fetchRecentReports();
        if (fresh && fresh.length) {
            _writeRecentCache(fresh.slice(0, 3));
            _renderRecentList(fresh);
        } else if (!cached) {
            _renderRecentList([]);
        }
    }

    // ── Init ────────────────────────────────────────────────────────────
    function init() {
        _renderChannels();
        _wireConsent();
        _wireInstallPrompt();
        _wireChannelTelemetry();
        _wireDevidBadge();
        _wireAccountMenu();
        // Phase 18 — new wirings.
        _wireInstallIcon();
        _wireHomeVoice();
        _wireUtilityFooter();
        _paintIdentityBar();
        // View-all button in recent-reports → openMyReports
        const viewAll = document.getElementById('btn-home-recent-viewall');
        if (viewAll) viewAll.addEventListener('click', () => {
            if (typeof window.openMyReports === 'function') window.openMyReports();
            else if (typeof window.goToStage === 'function') window.goToStage('stage-history');
        });
        // Repaint on auth state changes.
        document.addEventListener('auth-ready', _paintIdentityBar);
        document.addEventListener('auth-changed', _paintIdentityBar);
        document.addEventListener('crisp-i18n-applied', _paintIdentityBar);
        // Re-apply i18n after we built the channel buttons — every
        // channel anchor carries `data-i18n` on its label, and applyI18n()
        // walks the whole tree.
        if (typeof window.applyI18n === 'function') {
            try { window.applyI18n(); } catch (e) { console.warn('[home] i18n failed', e); }
        }
        // Notify listeners that the home is rendered.
        try {
            document.dispatchEvent(new CustomEvent('crisp-home-rendered'));
        } catch (_) {}
    }

    // Expose for tests + late re-init (locale change re-renders channels
    // for fresh translations).
    window.CrispHome = {
        init,
        renderChannels: _renderChannels,
        hasConsented: _hasConsented,
        markConsent: _markConsent,
        paintIdentityBar: _paintIdentityBar,
        paintDevidBadge: _paintDevidBadge,
        renderRecentReports: _renderRecentReports,
        // Phase 18 — exposed for app.js to call after _submittedCache
        // mutations + after profile fetches.
        paintBadgeChip: _renderBadgeChip,
        paintMyReportsCount: _renderMyReportsCount,
        _channels: CHANNELS,  // for test inspection
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
