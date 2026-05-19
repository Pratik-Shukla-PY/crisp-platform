// ──────────────────────────────────────────────────────────────────────────
// CRISP — Always-on home screen.
//
// Replaces landing.js. The first-visit-only landing
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
        // Telegram bot username corrected to @crisp_crisis_bot
        // per operator confirmation. Old `crisp_undp_bot` was a reserved
        // placeholder (Telegram page showed "Contact @crisp_undp_bot" with
        // the generic Send-Message button → no real bot → "breaks in
        // between" failure). The real bot at @crisp_crisis_bot resolves
        // with a "Launch" button + custom OG title "CRISP Crisis Report",
        // confirmed via curl against t.me/crisp_crisis_bot.
        //
        // Other channels stay empty-string → "Coming soon" toast until
        // their backends are actually wired. Operators can override any
        // of these via `window.CRISP_CHANNELS = { ... }` before this
        // script loads.
        ivr_phone: '+16626768896',                              // LIVE — operator-confirmed
        sms_phone: '',                                          // Coming soon
        telegram_bot: 'crisp_crisis_bot',                       // LIVE — https://t.me/crisp_crisis_bot
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

    // ── Phase 23 — Telegram deep-link with PWA device-hash token ────────
    //
    // The cleanest onboarding flow is: tap tile → Telegram app opens
    // directly in the bot chat → `/start <hash>` is already sent →
    // bot greets the user with context from prior PWA reports. If the
    // app isn't installed, fall back to the platform's app store.
    //
    // PWA device-hash format: `PWA-` + 32 lowercase hex chars
    // (generated in app.js around line 6340 via SHA-256). Telegram's
    // `start` parameter allows `[A-Za-z0-9_-]` 1-64 chars — the bare
    // 32-hex part already qualifies, no encoding needed.
    function _buildTelegramStartToken() {
        try {
            const raw = localStorage.getItem('crisp_device_id_v2')
                || localStorage.getItem('crisp_device_hash')
                || localStorage.getItem('crisp_device_id') || '';
            const stripped = String(raw).replace(/^PWA-/i, '').toLowerCase();
            // Must be exactly 32 hex chars to satisfy the bot's
            // re-validation (`^[0-9a-f]{32}$`); otherwise fall back
            // to a generic analytics tag so the bot still knows
            // the visit came from the PWA tile.
            if (/^[0-9a-f]{32}$/.test(stripped)) return stripped;
        } catch (_) {}
        return 'crisp_web';
    }
    function _telegramDeepLink(handle, startToken) {
        const bot = String(handle || '').replace(/^@/, '');
        if (!bot) return null;
        const tok = encodeURIComponent(startToken || 'crisp_web');
        const botEnc = encodeURIComponent(bot);
        return {
            // Native scheme — opens the installed Telegram app directly.
            native:  `tg://resolve?domain=${botEnc}&start=${tok}`,
            // Web URL with the same payload — handles desktop and the
            // "Telegram not installed on mobile" case by showing the
            // contact page with a Launch button.
            web:     `https://t.me/${bot}?start=${tok}`,
            // Platform-specific store URLs for the
            // "no Telegram + native scheme failed" path.
            ios:     'https://apps.apple.com/app/telegram-messenger/id686449807',
            android: 'https://play.google.com/store/apps/details?id=org.telegram.messenger',
        };
    }
    function _platformFamily() {
        // Reuse InstallPrompt.platform if it's already booted (lives
        // in install-prompt.js); otherwise inline a UA check. Returns
        // 'ios' | 'android' | 'desktop'.
        try {
            const p = window.InstallPrompt && window.InstallPrompt.platform;
            if (p === 'ios' || p === 'android') return p;
            if (p === 'standalone') return 'ios';   // PWA on iOS reports standalone
        } catch (_) {}
        const ua = (navigator.userAgent || '').toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) return 'ios';
        if (/android/.test(ua)) return 'android';
        return 'desktop';
    }
    // Runs on tap of the Telegram channel tile.
    //
    // simplified to a single universal-link navigation.
    // The earlier Phase 23 approach (transient iframe with `tg://`
    // scheme + visibilitychange-based fallback to App Store) was
    // unreliable on iOS 16+: when the OS shows the system "Open in
    // Telegram?" confirmation sheet, the page technically stays
    // visible, so visibilitychange doesn't fire within our 1.2 s
    // window and we wrongly redirect to the App Store — even when
    // Telegram IS installed. Real-user impact: tapping the tile on
    // an iPhone with Telegram installed routed straight to the App
    // Store. The universal-link form below sidesteps that entirely:
    //
    //   • iOS:     `https://t.me/<bot>?start=<token>` is registered
    //              as a Universal Link by Telegram. Safari either
    //              opens Telegram directly (if the user has previously
    //              opted into the t.me handler) OR shows the t.me web
    //              preview page with a "Launch in Telegram" banner
    //              that does it on the next tap. Never wrongly
    //              redirects to the App Store.
    //   • Android: same URL is App-Linked to Telegram on every
    //              device with the app installed → opens directly.
    //              Devices without Telegram see the same web preview
    //              with an "Install Telegram" button.
    //   • Desktop: opens in a new tab; Telegram Web handles login +
    //              launch.
    //
    // The `?start=<token>` payload still carries the PWA device-hash
    // so the bot's /start handler can link the Telegram session to
    // the same anonymous identity as the PWA reports.
    function _openTelegram(handle) {
        const links = _telegramDeepLink(handle, _buildTelegramStartToken());
        if (!links) return;
        const fam = _platformFamily();
        console.log(`[home] channel tap: telegram (fam=${fam})`);
        if (fam === 'desktop') {
            window.open(links.web, '_blank', 'noopener');
            return;
        }
        // Mobile: just navigate to the universal URL. iOS / Android
        // handle the app-or-web routing natively, including the
        // "open in app?" prompt when needed.
        window.location.href = links.web;
    }
    // Expose for tests / external instrumentation.
    try { window.CrispHome = window.CrispHome || {}; } catch (_) {}

    // ── Consent helpers (matches landing.js's previous contract) ────────
    function _hasConsented() {
        try { return !!localStorage.getItem(CONSENT_KEY); } catch { return false; }
    }
    function _markConsent() {
        try {
            localStorage.setItem(CONSENT_KEY, JSON.stringify({ accepted: true, ts: Date.now() }));
        } catch {}
    }

    // ── Channels: icon strip + bottom sheet ─────────────────────────────
    //
    // Phase 5.1 (May 2026, operator-requested NO-SCROLL pass). The old
    // 2 × 3 square-tile grid (~210 px tall) was replaced with a single
    // horizontal icon strip (~44 px tall) that opens a bottom sheet on
    // tap. The strip is the only surface visible on the home stage; the
    // sheet contains the full channel cards (icon + label + status text
    // + tap-to-launch) and is lazily painted on first open. See
    // docs/NEARBY_REPORTS_PIPELINE.md sibling sheet pattern + CLAUDE.md
    // "NO vertical scroll on home stage" invariant.

    /**
     * Single source of truth for the 6 channel definitions. Both the
     * strip (icon-only) and the bottom-sheet (full cards) consume this
     * list so adding a new channel only requires one edit.
     */
    // Inline SVG icons for the 6 channels.
    // May 2026 (perf Sprint B.2) — these used to render as FontAwesome
    // `<i class="fa-brands fa-...">` glyphs, requiring the ~117 KB
    // fa-brands.woff2 file to be fetched on cold-load just for the
    // channels strip. Inlining these 6 SVGs eliminates that fetch
    // (and the fa-solid fetch for IVR + SMS) from the home critical
    // path. Each icon is ~300-500 bytes inline → ~3 KB total vs the
    // 142 KB FontAwesome cost.
    //
    // Paths borrowed from open-source icon sets (Simple Icons for
    // brand marks, Lucide for the generic shapes) so attribution is
    // intact via the cdnjs FontAwesome stylesheet already loaded for
    // V4 capture stages.
    const _CHANNEL_SVGS = {
        // Telegram — Simple Icons paper-plane outline, filled.
        telegram: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                  '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>' +
                  '</svg>',
        // WhatsApp — Simple Icons phone in speech-bubble.
        whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                  '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.030-.967-.272-.099-.470-.149-.669.150-.197.297-.767.966-.940 1.164-.173.199-.347.223-.644.075-.297-.150-1.255-.463-2.39-1.475-.883-.788-1.480-1.761-1.653-2.059-.173-.297-.018-.458.130-.606.134-.133.297-.347.446-.520.149-.174.198-.298.298-.497.099-.198.050-.371-.025-.520-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.500-.669-.510-.173-.008-.371-.010-.570-.010-.198 0-.520.074-.792.371-.272.297-1.040 1.016-1.040 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.200 5.077 4.487.710.306 1.263.489 1.694.625.712.227 1.360.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.570-.347zM12.000 21.785h-.005c-1.937-.001-3.852-.520-5.523-1.502l-.396-.235-4.110 1.078 1.097-4.005-.258-.411c-1.080-1.717-1.650-3.703-1.650-5.749 0-5.946 4.842-10.788 10.792-10.788 2.881.001 5.589 1.124 7.624 3.16 2.034 2.039 3.155 4.749 3.153 7.633-.003 5.946-4.844 10.789-10.785 10.789zm9.180-19.973c-2.452-2.452-5.715-3.802-9.182-3.804-7.143 0-12.954 5.811-12.957 12.953-.001 2.283.596 4.51 1.731 6.474l-1.840 6.715 6.870-1.802c1.892 1.031 4.022 1.576 6.190 1.577h.005c7.142 0 12.953-5.811 12.956-12.954.002-3.466-1.349-6.726-3.802-9.179z"/>' +
                  '</svg>',
        // SMS — Lucide message-square.
        sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
             '</svg>',
        // IVR / phone — Lucide phone (slightly stylised handset).
        ivr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
             '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>' +
             '</svg>',
        // Android — Simple Icons android robot head.
        android: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
                 '<path d="M17.523 15.341c-.5523 0-1-.4477-1-1s.4477-1 1-1 1 .4477 1 1-.4477 1-1 1m-11.046 0c-.5523 0-1-.4477-1-1s.4477-1 1-1 1 .4477 1 1-.4477 1-1 1m11.405-6.027 1.997-3.46a.416.416 0 0 0-.152-.568.416.416 0 0 0-.568.152l-2.022 3.503A12.572 12.572 0 0 0 12 7.5c-1.886 0-3.679.353-5.137 1.041L4.842 5.038a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.568l1.997 3.46C2.7 11.115.527 14.158.072 17.62h23.856c-.455-3.462-2.628-6.505-6.046-8.306z"/>' +
                 '</svg>',
        // iOS / Apple — Simple Icons apple silhouette.
        ios: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
             '<path d="M17.05 20.28c-.98.95-2.05.88-3.08.43-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.44C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>' +
             '</svg>',
    };

    function _buildChannelsList() {
        const _tt = (typeof window.t === 'function') ? window.t : (k, f) => f || k;
        const stLive  = _tt('live_now',        'Live now');
        const stSoon  = _tt('coming_soon',     'Coming soon');
        const stLowBw = _tt('low_bandwidth',   'Low bandwidth');
        return [
            {
                key: 'telegram', label: 'Telegram',
                iconSvg: _CHANNEL_SVGS.telegram, color: '--brand-telegram',
                live: !!CHANNELS.telegram_bot,
                href: '',
                // Telegram uses a JS deep-link handler instead of a
                // raw anchor — see _wireChannelsSheetTelemetry.
                dataAction: CHANNELS.telegram_bot ? 'telegram-deeplink' : '',
                status: CHANNELS.telegram_bot ? stLive : stSoon,
            },
            {
                key: 'whatsapp', label: 'WhatsApp',
                iconSvg: _CHANNEL_SVGS.whatsapp, color: '--brand-whatsapp',
                live: !!CHANNELS.whatsapp_phone,
                href: _whatsappLink(CHANNELS.whatsapp_phone, 'CRISP report'),
                status: CHANNELS.whatsapp_phone ? stLive : stSoon,
            },
            {
                key: 'sms', label: 'SMS',
                iconSvg: _CHANNEL_SVGS.sms, color: '--brand-sms',
                live: !!CHANNELS.sms_phone,
                href: _smsLink(CHANNELS.sms_phone, 'CRISP help'),
                status: stLowBw,
            },
            {
                key: 'ivr', label: 'IVR',
                iconSvg: _CHANNEL_SVGS.ivr, color: '--brand-ivr',
                live: !!CHANNELS.ivr_phone,
                href: _telLink(CHANNELS.ivr_phone),
                // Operator (May 2026): "Live" reads cleaner than
                // "Voice reporting" alongside Telegram's "Live now".
                status: CHANNELS.ivr_phone ? stLive : stSoon,
            },
            {
                key: 'android', label: 'Android',
                iconSvg: _CHANNEL_SVGS.android, color: '--good',
                live: !!CHANNELS.android_app_url,
                href: CHANNELS.android_app_url || '',
                status: CHANNELS.android_app_url ? stLive : stSoon,
            },
            {
                key: 'ios', label: 'iOS',
                iconSvg: _CHANNEL_SVGS.ios, color: '--brand-ios',
                live: !!CHANNELS.ios_app_url,
                href: CHANNELS.ios_app_url || '',
                status: CHANNELS.ios_app_url ? stLive : stSoon,
            },
        ];
    }

    /**
     * Paint the home-stage strip — 6 icon spans, no labels, status
     * dots only on active channels. The whole strip is one click
     * target that opens the bottom sheet (operator decision: a single
     * predictable target is easier than per-icon launches).
     */
    function _renderChannelsStrip() {
        const strip = document.getElementById('home-channels-strip');
        if (!strip) return;
        const items = _buildChannelsList();
        strip.innerHTML = items.map((i) => {
            const stateClass = i.live ? 'hcs-icon--live' : 'hcs-icon--soon';
            const colorStyle = i.color ? ` style="--c: var(${i.color});"` : '';
            return `<span class="hcs-icon ${stateClass} hcs-icon--${i.key}"${colorStyle} aria-hidden="true">${i.iconSvg}</span>`;
        }).join('');
        // Bind once — re-rendering the strip shouldn't multiply listeners.
        strip.onclick = (e) => {
            e.preventDefault();
            _openChannelsSheet();
        };
        // Make sure the section is visible (legacy contract).
        const section = strip.closest('.home-section');
        if (section) section.style.display = '';
    }

    /**
     * Build a single row inside the bottom sheet. Mirrors the
     * _buildChannelTile contract (data-channel + data-action + href +
     * is-live/is-disabled state) so the click delegation in
     * _wireChannelsSheetTelemetry works without per-key special cases.
     */
    function _buildSheetRow(o) {
        const safeLabel  = String(o.label).replace(/"/g, '&quot;');
        const safeStatus = String(o.status || '').replace(/"/g, '&quot;');
        const safeKey    = String(o.key).replace(/"/g, '&quot;');
        const safeColor  = o.color || '--accent';
        const stateClass = o.live ? 'is-live' : 'is-disabled';
        const body = `
            <span class="csr-icon" aria-hidden="true">${o.iconSvg}</span>
            <span class="csr-text">
                <span class="csr-label">${safeLabel}</span>
                <span class="csr-status">${safeStatus}</span>
            </span>
            <span class="csr-arrow" aria-hidden="true">›</span>`;
        if (o.dataAction) {
            return `
                <button type="button" class="channels-sheet-row ${stateClass}"
                        style="--c: var(${safeColor});"
                        data-channel="${safeKey}"
                        data-action="${o.dataAction}"
                        aria-label="${safeLabel}">${body}</button>
            `;
        }
        if (!o.href || !o.live) {
            return `
                <button type="button" class="channels-sheet-row ${stateClass}"
                        data-channel="${safeKey}"
                        aria-label="${safeLabel} — ${safeStatus}"
                        aria-disabled="${o.live ? 'false' : 'true'}">${body}</button>
            `;
        }
        const targetAttr = (
            o.href.startsWith('tel:') || o.href.startsWith('sms:') || o.href.startsWith('exp:')
                ? ''
                : 'target="_blank" rel="noopener"'
        );
        const safeHref = String(o.href).replace(/"/g, '&quot;');
        return `
            <a class="channels-sheet-row ${stateClass}"
               style="--c: var(${safeColor});"
               href="${safeHref}" ${targetAttr}
               data-channel="${safeKey}"
               aria-label="${safeLabel}">${body}</a>
        `;
    }

    /**
     * Paint the channels bottom sheet. Called lazily on first open
     * so the home-stage critical path doesn't pay for sheet markup.
     */
    function _renderChannelsSheet() {
        const list = document.getElementById('channels-sheet-list');
        if (!list) return;
        list.innerHTML = _buildChannelsList().map(_buildSheetRow).join('');
    }

    function _openChannelsSheet() {
        const sheet = document.getElementById('channels-sheet');
        if (!sheet) return;
        if (!sheet.dataset.populated) {
            _renderChannelsSheet();
            _wireChannelsSheetTelemetry();
            sheet.dataset.populated = '1';
        }
        sheet.hidden = false;
        // requestAnimationFrame so the [hidden] removal lands before
        // .is-open kicks the translateY transition — otherwise the
        // browser collapses the change to a single paint with no
        // animation. Same trick as the nearby sheet.
        requestAnimationFrame(() => sheet.classList.add('is-open'));
        const closeBtn = document.getElementById('channels-sheet-close');
        if (closeBtn) setTimeout(() => { try { closeBtn.focus(); } catch (_) {} }, 60);
    }

    function _closeChannelsSheet() {
        const sheet = document.getElementById('channels-sheet');
        if (!sheet) return;
        sheet.classList.remove('is-open');
        // 240 ms matches the .nearby-sheet exit transition; hide
        // AFTER the animation ends so the user sees it slide away
        // rather than blink-disappear.
        setTimeout(() => { sheet.hidden = true; }, 240);
        const strip = document.getElementById('home-channels-strip');
        if (strip) { try { strip.focus(); } catch (_) {} }
    }

    function _wireChannelsSheet() {
        const sheet = document.getElementById('channels-sheet');
        if (!sheet) return;
        const backdrop = document.getElementById('channels-sheet-backdrop');
        const closeBtn = document.getElementById('channels-sheet-close');
        if (backdrop && !backdrop.dataset.wired) {
            backdrop.addEventListener('click', _closeChannelsSheet);
            backdrop.dataset.wired = '1';
        }
        if (closeBtn && !closeBtn.dataset.wired) {
            closeBtn.addEventListener('click', _closeChannelsSheet);
            closeBtn.dataset.wired = '1';
        }
        // Esc closes from anywhere on the page.
        if (!document.body.dataset.channelsEscWired) {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && sheet.classList.contains('is-open')) {
                    _closeChannelsSheet();
                }
            });
            document.body.dataset.channelsEscWired = '1';
        }
    }

    /**
     * Click-delegation for the rows inside the bottom sheet. Same
     * routing rules as the pre-Phase-5.1 _wireChannelTelemetry but
     * targets the new .channels-sheet-row markup. Disabled channels
     * surface a "coming soon" toast; Telegram routes through the
     * deep-link handler; everything else uses native anchor / button
     * navigation. The sheet auto-closes after a successful tap so
     * the next return-to-home doesn't have a stale open overlay.
     */
    function _wireChannelsSheetTelemetry() {
        document.querySelectorAll('#channels-sheet-list [data-channel]')
            .forEach((el) => {
                if (el.dataset.wired) return;
                el.dataset.wired = '1';
                el.addEventListener('click', (e) => {
                    const key = el.getAttribute('data-channel');
                    if (el.classList.contains('is-disabled')) {
                        e.preventDefault();
                        e.stopPropagation();
                        const labelEl = el.querySelector('.csr-label');
                        const label = labelEl ? labelEl.textContent.trim() : key;
                        _showComingSoonToast(label);
                        return;
                    }
                    const action = el.getAttribute('data-action');
                    if (action === 'telegram-deeplink') {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            _openTelegram(CHANNELS.telegram_bot);
                        } catch (err) {
                            console.warn('[home] telegram deep-link failed:', err);
                            const fallback = _telegramLink(CHANNELS.telegram_bot);
                            if (fallback) window.open(fallback, '_blank', 'noopener');
                        }
                        setTimeout(() => _closeChannelsSheet(), 80);
                        return;
                    }
                    // Native anchor / button click handles navigation;
                    // close the sheet on the next tick so the user
                    // returns to a clean home stage.
                    setTimeout(() => _closeChannelsSheet(), 30);
                    console.log(`[home] channel tap: ${key}`);
                });
            });
    }

    /**
     * Back-compat wrapper. The original entry point at app boot
     * called `_renderChannels()`; we keep that name working so any
     * external override doesn't break. The new behaviour: paint the
     * strip + wire the sheet (sheet contents painted lazily on
     * first open inside _openChannelsSheet).
     */
    function _renderChannels() {
        _renderChannelsStrip();
        _wireChannelsSheet();
        // #home-apps is the legacy 2nd-row container; remains hidden.
        const appsEl = document.getElementById('home-apps');
        if (appsEl) appsEl.innerHTML = '';
    }

    // brief in-place toast for "coming soon" channel taps.
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

    /**
     * Wire the v6 "Add to Homescreen" yellow chip (#btn-home-add2hs)
     * pinned below the Privacy / CRISP-ID footer row.
     *
     * Visibility rule (operator-decision May 2026, ask #3):
     *   hidden EXCEPT when window.InstallPrompt reports `canInstall &&
     *   platform !== 'standalone'`. The chip disappears the moment the
     *   user installs (display-mode flips to standalone OR the
     *   `appinstalled` event fires) so returning installed-PWA users
     *   never see a stale "Add to Homescreen" CTA.
     *
     * Click → window.InstallPrompt.show() — Android fires the native
     * `beforeinstallprompt`-cached prompt; iOS Safari opens the
     * "How to install on iPhone" sheet from the existing module.
     */
    function _wireAddToHomescreenChip() {
        if (!window.InstallPrompt) return;
        const chip = document.getElementById('btn-home-add2hs');
        if (!chip) return;
        if (chip.__crispAdd2hsWired) return;
        chip.__crispAdd2hsWired = true;

        window.InstallPrompt.onChange(({ canInstall, platform }) => {
            // Hidden in installed-PWA mode AND when no install prompt
            // is available (e.g. desktop Chrome that already added it).
            const visible = !!canInstall && platform !== 'standalone';
            if (visible) chip.removeAttribute('hidden');
            else chip.setAttribute('hidden', '');
        });

        chip.addEventListener('click', async () => {
            try { await window.InstallPrompt.show(); }
            catch (e) { console.warn('[home] add-to-hs prompt failed:', e); }
        });
    }
    // Expose for the boot sequence (called from the same DOMContentLoaded
    // initialiser that runs the other _wire* fns).
    window._wireAddToHomescreenChip = _wireAddToHomescreenChip;

    // ── Channel telemetry + disabled-tile toast ────────────────────────
    // non-working (`.is-disabled`) tiles surface a brief
    // "Coming soon" toast on click. Working tiles just log a telemetry
    // breadcrumb and let the browser follow the anchor href.
    //
    // tiles carrying a `data-action` (currently only
    // `telegram-deeplink`) are dispatched to a custom handler that
    // runs the native-scheme → store-fallback chain instead of
    // letting the browser navigate. preventDefault stops any
    // accidental anchor default; stopPropagation isolates the click
    // from the form / consent listeners.
    function _wireChannelTelemetry() {
        // Phase 5.1 (May 2026, NO-SCROLL pass) — the home-stage strip
        // is a single click target that opens the bottom sheet, so
        // there's no per-channel data-channel handler to attach
        // there. The per-channel routing now lives in
        // _wireChannelsSheetTelemetry (called lazily on first sheet
        // open). The selector below is kept for the LEGACY
        // #home-channels / #home-apps containers in case some
        // operator-deployed surface still uses them.
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
                    const action = el.getAttribute('data-action');
                    if (action === 'telegram-deeplink') {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            _openTelegram(CHANNELS.telegram_bot);
                        } catch (err) {
                            console.warn('[home] telegram deep-link failed:', err);
                            // Last-ditch fallback — open the web URL.
                            const fallback = _telegramLink(CHANNELS.telegram_bot);
                            if (fallback) window.open(fallback, '_blank', 'noopener');
                        }
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

        // Shared copy routine — used by both the icon button (when
        // visible) and the whole-pill tap path below.
        async function _copyDevidToClipboard() {
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
        }

        // Copy → clipboard with brief visual confirmation.
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _copyDevidToClipboard();
            });
        }

        // v2 footer pass (May 2026) — when the badge sits in the
        // bottom footer-row, the copy + info icon buttons are hidden
        // by CSS (`.home-footer-row .home-devid-badge button { display:none }`)
        // to match the operator's reference screenshot. The whole
        // pill then becomes the copy affordance. We add a tap handler
        // directly on the badge that no-ops when an inner button
        // (still in DOM, still clickable on the non-footer identity-
        // bar surface) handles the event first via stopPropagation.
        badge.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;     // icon handlers own the event
            _copyDevidToClipboard();
        });
        // Keyboard / a11y: make the pill itself focusable + Enter/Space
        // trigger the same copy. tabindex only when no inner button has
        // focus to avoid double-tabbing the same control.
        if (!badge.hasAttribute('tabindex')) badge.setAttribute('tabindex', '0');
        if (!badge.hasAttribute('role')) badge.setAttribute('role', 'button');
        badge.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('button')) return;
            e.preventDefault();
            _copyDevidToClipboard();
        });

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
        const recentBlock = document.getElementById('home-recent');
        // May 2026 (landing-icon cleanup pass) — the legacy full-width
        // #btn-login row + #btn-my-reports hide-on-login dance is GONE.
        // My Reports + Rewards stay visible in every auth state (the
        // dropdown menu's My Reports entry is a redundant fast-path
        // for power users). Auth state is communicated by:
        //   • #btn-home-login-icon dot colour (red ⇒ anonymous,
        //     green ⇒ signed in), and
        //   • the "Welcome back, {name}." home-title-sub line.
        const loginIcon = document.getElementById('btn-home-login-icon');
        const loginDot = document.getElementById('home-login-dot');
        if (!devidWrap || !acctWrap) return;

        const loggedIn = _isLoggedIn();
        const tt = (typeof window.t === 'function') ? window.t : (k) => k;
        if (loggedIn) {
            devidWrap.setAttribute('hidden', '');
            acctWrap.removeAttribute('hidden');
            // Account name still gets written to the sr-only span for
            // screen-readers + dropdown-menu accessors that look it up.
            try {
                const u = window.AuthStore.getUser && window.AuthStore.getUser();
                if (u && acctName) {
                    acctName.textContent = u.displayName || u.id || '—';
                }
            } catch (_) {}
            // supratext above the CTA reads "Welcome back, {name}."
            if (subEl) {
                const u = (window.AuthStore && window.AuthStore.getUser && window.AuthStore.getUser()) || {};
                const name = (u.displayName || '').split(/\s+/)[0] || '';
                const tmpl = tt('home_greeting_loggedin') || 'Welcome back, {name}.';
                subEl.textContent = name ? tmpl.replace('{name}', name) : '';
                if (name) subEl.removeAttribute('hidden'); else subEl.setAttribute('hidden', '');
            }
            // Recolour the login icon — GREEN dot, mint-tinted pill,
            // "Account" aria-label so screen-readers announce the
            // correct intent (tap → open account menu).
            if (loginIcon) {
                loginIcon.setAttribute('data-state', 'signed-in');
                const label = tt('home_login_icon_signed_in') || 'Account';
                loginIcon.setAttribute('aria-label', label);
                loginIcon.setAttribute('title', label);
            }
            if (loginDot) {
                loginDot.classList.remove('dot-offline');
                loginDot.classList.add('dot-online');
            }
            // Show recent-reports block (will populate async).
            if (recentBlock) recentBlock.removeAttribute('hidden');
            _renderRecentReports();
        } else {
            acctWrap.setAttribute('hidden', '');
            devidWrap.removeAttribute('hidden');
            if (subEl) subEl.setAttribute('hidden', '');
            // Recolour the login icon — RED dot, default pill,
            // "Sign in" aria-label.
            if (loginIcon) {
                loginIcon.setAttribute('data-state', 'anonymous');
                const label = tt('home_login_icon_signed_out') || 'Sign in';
                loginIcon.setAttribute('aria-label', label);
                loginIcon.setAttribute('title', label);
            }
            if (loginDot) {
                loginDot.classList.remove('dot-online');
                loginDot.classList.add('dot-offline');
            }
            // Hide recent-reports block.
            if (recentBlock) recentBlock.setAttribute('hidden', '');
        }
        // repaint badge chip + My Reports count for both states.
        try { _renderBadgeChip(); } catch (_) {}
        try { _renderMyReportsCount(); } catch (_) {}
        try { _wireRewardsNav(); } catch (_) {}
    }

    // ── Login icon — toggle account menu when signed in, route to
    //    stage-login when anonymous. Wired once at boot; the
    //    icon's data-state attribute is the source of truth.
    function _wireLoginIcon() {
        const btn = document.getElementById('btn-home-login-icon');
        if (!btn || btn.__crispLoginWired) return;
        btn.__crispLoginWired = true;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const signedIn = btn.getAttribute('data-state') === 'signed-in';
            if (signedIn) {
                // Toggle the account dropdown menu (same as the old
                // account-pill click before the cleanup pass).
                const menu = document.getElementById('home-account-menu');
                if (!menu) return;
                const isOpen = !menu.hasAttribute('hidden');
                if (isOpen) menu.setAttribute('hidden', '');
                else menu.removeAttribute('hidden');
                btn.setAttribute('aria-expanded', String(!isOpen));
            } else {
                // Route to stage-login. _resetLoginForm + goToStage
                // are exposed on window by app.js.
                try {
                    if (typeof window._resetLoginForm === 'function') {
                        window._resetLoginForm();
                    }
                } catch (_) {}
                if (typeof window.goToStage === 'function') {
                    window.goToStage('stage-login');
                }
            }
        });
        // Outside-click dismisses the menu (already handled by
        // _wireAccountMenu but the login icon button isn't part of
        // home-account-wrap, so its click must not trigger the
        // existing handler's outside-click dismiss — hence the
        // e.stopPropagation above).
    }

    // ── Phase 18 — badge chip + My Reports count + voice + install ────
    //
    // Badge chip — May 2026 second-pass rewrite to the 4-tier
    // identity-forward ladder driven by /reports/profile/<hash>:
    //   T1 SCOUT       🌱 — default (0 reports)
    //   T2 SIGNAL      📣 — ≥1 report submitted
    //   T3 CHANGEMAKER ⚡ — ≥1 report dispatched (RESPONDING/RESOLVED)
    //   T4 LIFEKEEPER  🦸 — ≥1 life saved (analyst-set lives_impacted)
    //
    // Pre-fix the map carried 5 legacy tier names (NEWCOMER / HELPER /
    // GUARDIAN / CHAMPION / HERO) that the backend stopped emitting in
    // April 2026. Any reporter at CONTRIBUTOR / TRUSTED was rendering
    // as "🌱 Newcomer" forever because the lookup fell through to the
    // default. LEGACY_MAP below catches a stale backend response from
    // before the v1→v2 deploy completes; new shells read `badge_level`
    // directly.
    //
    // sessionStorage caches the last paint payload for instant repaint.
    const BADGE_LEVELS = {
        T1_SCOUT:        { emoji: '🌱', cls: 'lvl-t1', i18nKey: 'tier_t1_scout_label',        bodyCls: 'tier-t1' },
        T2_SIGNAL:       { emoji: '📣', cls: 'lvl-t2', i18nKey: 'tier_t2_signal_label',       bodyCls: 'tier-t2' },
        T3_CHANGEMAKER:  { emoji: '⚡', cls: 'lvl-t3', i18nKey: 'tier_t3_changemaker_label',  bodyCls: 'tier-t3' },
        T4_LIFEKEEPER:   { emoji: '🦸', cls: 'lvl-t4', i18nKey: 'tier_t4_lifekeeper_label',   bodyCls: 'tier-t4' },
    };
    // Legacy 3-tier name → new 4-tier identifier. Lets the PWA cope
    // with a backend that has not yet been upgraded (or a sessionStorage
    // cache from a pre-v145 PWA shell).
    const LEGACY_MAP = {
        NEWCOMER:    'T2_SIGNAL',       // 3-tier NEWCOMER mapped to "submitted reports" tier
        CONTRIBUTOR: 'T3_CHANGEMAKER',
        TRUSTED:     'T4_LIFEKEEPER',
    };
    // English fallbacks used while the JSON i18n bundle is still
    // loading (window.t() returns the key itself when not resolved).
    const ENGLISH_FALLBACKS = {
        'tier_t1_scout_label':        'Scout',
        'tier_t2_signal_label':       'Signal',
        'tier_t3_changemaker_label':  'Changemaker',
        'tier_t4_lifekeeper_label':   'Lifekeeper',
        'tier_progress_first_report': 'Submit your first report to level up',
        'tier_progress_verified_1':   'Get 1 report verified by an analyst',
        'tier_progress_lives_1':      'Help save 1 life through your reports',
        'tier_progress_top_share':    'Top tier reached — tap to share your badge',
    };
    const BADGE_CACHE_KEY = 'crisp_home_badge_v2'; // bumped v1→v2 for new shape
    function _readBadgeCache() {
        try { return JSON.parse(sessionStorage.getItem(BADGE_CACHE_KEY) || 'null'); } catch { return null; }
    }
    function _writeBadgeCache(payload) {
        try { sessionStorage.setItem(BADGE_CACHE_KEY, JSON.stringify(payload || null)); } catch {}
    }
    function _resolveLevel(rawLevel) {
        // Normalize backend response to a known T1-T4 identifier.
        // Order: exact 4-tier match → legacy 3-tier fallback → T1_SCOUT
        // (never hide the chip).
        const key = String(rawLevel || '').toUpperCase();
        if (BADGE_LEVELS[key]) return key;
        if (LEGACY_MAP[key]) return LEGACY_MAP[key];
        return 'T1_SCOUT';
    }
    function _tString(key) {
        // Resolve an i18n key with the EN fallback when t() hasn't
        // hydrated yet. Used for the progress sub-line where the
        // backend tells us WHICH key to render.
        const fallback = ENGLISH_FALLBACKS[key] || '';
        if (typeof window.t === 'function') {
            const v = window.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }
    function _applyBodyTierClass(level) {
        // Apply a body-level tier class so per-tier CSS (logo accent
        // ring at T3+, theme tint at T4) attaches without a JS render
        // round-trip. We strip every other tier class first so a
        // demotion (rare; would only happen via a manual DB tweak)
        // cleans up too.
        try {
            const body = document.body;
            if (!body) return;
            Object.values(BADGE_LEVELS).forEach((d) => body.classList.remove(d.bodyCls));
            const def = BADGE_LEVELS[level] || BADGE_LEVELS.T1_SCOUT;
            body.classList.add(def.bodyCls);
        } catch (_) {}
    }
    function _paintBadgeChip(payload) {
        // `payload` may be either a bare string (legacy cache from
        // v1) or the new v2 object {level, progress, lives, ...}.
        // Normalize both forms.
        let level, progressKey, lives;
        if (typeof payload === 'string') {
            level = _resolveLevel(payload);
            progressKey = null;
            lives = 0;
        } else if (payload && typeof payload === 'object') {
            level = _resolveLevel(payload.level);
            progressKey = payload.progressLabelKey || null;
            lives = Number.isFinite(payload.lives) ? payload.lives : 0;
        } else {
            level = 'T1_SCOUT';
            progressKey = 'tier_progress_first_report';
            lives = 0;
        }
        const chip = document.getElementById('home-badge-chip');
        const emojiEl = document.getElementById('home-badge-emoji');
        const labelEl = document.getElementById('home-badge-label');
        const progEl  = document.getElementById('home-badge-progress');
        if (!chip || !emojiEl || !labelEl) return;
        const def = BADGE_LEVELS[level] || BADGE_LEVELS.T1_SCOUT;
        emojiEl.textContent = def.emoji;
        labelEl.textContent = _tString(def.i18nKey) || 'Scout';
        // Progress sub-line — May 2026 declutter pass. For T4 the
        // previous "Top tier reached — tap to share your badge" was
        // both verbose AND misleading (the chip became decorative-
        // only when the dedicated Rewards page shipped — tapping does
        // nothing). T4 now shows the actual impact stat ("8 lives
        // saved"); other tiers keep their progress hint. The sub-line
        // element may be absent on cached shells without the v145
        // markup; guard accordingly.
        if (progEl) {
            if (level === 'T4_LIFEKEEPER' && Number.isFinite(lives) && lives > 0) {
                const tmpl = _tString('badge_chip_lives_stat') || '{n} lives saved';
                progEl.textContent = tmpl.replace('{n}', String(lives));
            } else {
                const key = progressKey || (
                    level === 'T1_SCOUT'       ? 'tier_progress_first_report' :
                    level === 'T2_SIGNAL'      ? 'tier_progress_verified_1'   :
                    level === 'T3_CHANGEMAKER' ? 'tier_progress_lives_1'      :
                                                 'tier_progress_top_share'
                );
                progEl.textContent = _tString(key);
            }
        }
        // Reset level classes then add the active one.
        Object.values(BADGE_LEVELS).forEach((d) => chip.classList.remove(d.cls));
        chip.classList.add(def.cls);
        chip.dataset.tier = level;
        // Top tier unlocks Badge Studio — surface this via a tappable
        // hint class so styles.css can render the chip slightly larger
        // / with a subtle "tap me" cue.
        chip.classList.toggle('chip-unlocked', level === 'T3_CHANGEMAKER' || level === 'T4_LIFEKEEPER');
        _applyBodyTierClass(level);
        chip.removeAttribute('hidden');
    }
    async function _renderBadgeChip() {
        const chip = document.getElementById('home-badge-chip');
        if (!chip) return;
        // Phase 2.8 (May 2026) — chip is now a <button>; wire a one-
        // time click handler that navigates to the dedicated Rewards
        // page (#stage-rewards). The dataset flag prevents duplicate
        // listeners across re-renders (the chip can re-paint several
        // times per page load — every status-since refresh).
        if (!chip.dataset.navBound) {
            chip.dataset.navBound = '1';
            chip.addEventListener('click', () => {
                // Phase F triage (May 2026): pre-fix this handler called
                // `goToStage('stage-rewards')` directly, leaving the ladder
                // cards + Badge Studio CTA unpainted (no `.is-current` /
                // `.is-locked` / `.is-done` classes, button never disabled
                // at T1/T2). `_openRewardsStage()` is the only path that
                // calls `_paintRewardsPage()` before the transition.
                try {
                    _openRewardsStage();
                } catch (_) {
                    // Fallback if open-rewards isn't ready yet — at least
                    // transition the stage so the user lands somewhere.
                    try {
                        if (typeof window.goToStage === 'function') {
                            window.goToStage('stage-rewards');
                        }
                    } catch (__) {}
                }
            });
        }
        // Optimistic paint from cache (legacy v1 cache also accepted —
        // _paintBadgeChip normalizes both shapes).
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
            // No device hash yet — default to T1_SCOUT so the chip
            // still shows something meaningful on first paint.
            if (!cached) _paintBadgeChip('T1_SCOUT');
            return;
        }
        try {
            const apiBase = window.API_BASE || '/api/v1';
            const res = await fetch(`${apiBase}/reports/profile/${encodeURIComponent(hash)}`);
            if (!res.ok) {
                // Backend error (4xx / 5xx) — keep the existing cached
                // paint if we have one, otherwise fall back to T1_SCOUT
                // so the chip never stays hidden. Returning early
                // without a fallback was the pre-fix behaviour and
                // left the chip invisible on any /profile 500.
                if (!cached) _paintBadgeChip('T1_SCOUT');
                return;
            }
            const p = await res.json();
            const payload = {
                level: _resolveLevel(p.badge_level),
                progressLabelKey: p.tier && p.tier.progress && p.tier.progress.label_key,
                lives: Number.isFinite(p.lives_saved_total) ? p.lives_saved_total : 0,
                reports: Number.isFinite(p.report_count) ? p.report_count : 0,
                responded: Number.isFinite(p.responded_count) ? p.responded_count : 0,
            };
            _paintBadgeChip(payload);
            _writeBadgeCache(payload);
        } catch (_) {
            // Network error — fall back to cached or T1_SCOUT. Never
            // hide the chip; "Scout" is the honest default.
            if (!cached) _paintBadgeChip('T1_SCOUT');
        }
    }

    // ── Rewards page (stage-rewards) — May 2026 second-pass UX ──
    // Renders the user's current tier + the 4-tier ladder + the
    // Badge Studio entry CTA. Reads sessionStorage `crisp_home_badge_v2`
    // (warm cache from _renderBadgeChip) for instant paint, then
    // re-fetches /profile in the background to refresh.
    //
    // Phase 2.1 (May 2026) — tier metadata sourced from the shared
    // canonical config exposed at `window.CRISP_TIERS{,BY_ID}`. The
    // hard-coded fallback is the SAME data, kept in source so this
    // file still works if the script tag for tier-config.js doesn't
    // load (e.g. legacy SW cache before the v198 update arrives).
    const _SHARED_TIERS = (typeof window !== 'undefined' && Array.isArray(window.CRISP_TIERS)) ? window.CRISP_TIERS : null;
    const TIER_ORDER = _SHARED_TIERS ? _SHARED_TIERS.map((t) => t.id) : ['T1_SCOUT', 'T2_SIGNAL', 'T3_CHANGEMAKER', 'T4_LIFEKEEPER'];
    const TIER_EMOJI = _SHARED_TIERS
        ? Object.fromEntries(_SHARED_TIERS.map((t) => [t.id, t.emoji]))
        : { T1_SCOUT: '🌱', T2_SIGNAL: '📣', T3_CHANGEMAKER: '⚡', T4_LIFEKEEPER: '🦸' };
    const TIER_UNLOCKED = new Set(['T3_CHANGEMAKER', 'T4_LIFEKEEPER']);

    function _resolveLevelFromAny(raw) {
        // Mirror of _renderBadgeChip's _resolveLevel — separate copy
        // so the rewards page can hydrate without touching the chip's
        // closure. Recognises both 4-tier identifiers and legacy
        // 3-tier names.
        const key = String(raw || '').toUpperCase();
        if (TIER_EMOJI[key]) return key;
        if (key === 'CONTRIBUTOR') return 'T3_CHANGEMAKER';
        if (key === 'TRUSTED')     return 'T4_LIFEKEEPER';
        if (key === 'NEWCOMER')    return 'T2_SIGNAL';   // matches LEGACY_MAP above
        return 'T1_SCOUT';
    }

    function _paintRewardsPage(payload) {
        // `payload` is the v2 sessionStorage shape: { level, progressLabelKey, lives, reports, responded }.
        const level = _resolveLevelFromAny(payload && payload.level);
        const emoji = TIER_EMOJI[level] || '🌱';
        const labelKey = `tier_${level.toLowerCase()}_label`;
        const tString = (k, fb) => {
            try { if (typeof window.t === 'function') {
                const v = window.t(k); if (v && v !== k) return v;
            } } catch (_) {}
            return fb;
        };

        // Hero card.
        const emojiEl = document.getElementById('rh-emoji');
        const nameEl  = document.getElementById('rh-name');
        const progEl  = document.getElementById('rh-progress');
        if (emojiEl) emojiEl.textContent = emoji;
        if (nameEl) {
            const fb = ({ T1_SCOUT: 'Scout', T2_SIGNAL: 'Signal', T3_CHANGEMAKER: 'Changemaker', T4_LIFEKEEPER: 'Lifekeeper' })[level];
            nameEl.textContent = tString(labelKey, fb);
        }
        if (progEl) {
            const pk = (payload && payload.progressLabelKey) || (
                level === 'T1_SCOUT'       ? 'tier_progress_first_report' :
                level === 'T2_SIGNAL'      ? 'tier_progress_verified_1'   :
                level === 'T3_CHANGEMAKER' ? 'tier_progress_lives_1'      :
                                             'tier_progress_top_share'
            );
            const fbProg = ({
                tier_progress_first_report: 'Submit your first report to level up',
                tier_progress_verified_1:   'Get 1 report verified by an analyst',
                tier_progress_lives_1:      'Help save 1 life through your reports',
                tier_progress_top_share:    'Top tier reached — tap to share your badge',
            })[pk] || '';
            progEl.textContent = tString(pk, fbProg);
        }

        // Ladder — each card carries .is-done / .is-current / .is-locked.
        const currentIdx = TIER_ORDER.indexOf(level);
        TIER_ORDER.forEach((tier, idx) => {
            const card = document.querySelector(`.rt-card[data-tier="${tier}"]`);
            if (!card) return;
            card.classList.toggle('is-done', idx < currentIdx);
            card.classList.toggle('is-current', idx === currentIdx);
            card.classList.toggle('is-locked', idx > currentIdx);
        });

        // Share CTA — copy + state depend on whether Badge Studio is
        // unlocked at the user's current tier.
        const hintEl = document.getElementById('rewards-share-hint');
        const btnEl  = document.getElementById('btn-rewards-open-studio');
        const unlocked = TIER_UNLOCKED.has(level);
        if (hintEl) {
            const hintKey = unlocked ? 'rewards_share_hint_unlocked' : 'rewards_share_hint_locked';
            const fb = unlocked
                ? 'Tap to create a share-ready badge image for LinkedIn, WhatsApp, Instagram, and more.'
                : 'Reach Changemaker to unlock badge sharing on LinkedIn, Instagram, WhatsApp.';
            hintEl.textContent = tString(hintKey, fb);
        }
        if (btnEl) {
            btnEl.disabled = !unlocked;
            btnEl.classList.toggle('is-locked', !unlocked);
        }
    }

    async function _refreshRewardsFromServer() {
        // Pull fresh /profile so the rewards page never lags the chip.
        let hash = '';
        try {
            hash = localStorage.getItem('crisp_device_id_v2')
                || localStorage.getItem('crisp_device_hash')
                || localStorage.getItem('crisp_device_id') || '';
        } catch (_) {}
        if (!hash) return;
        try {
            const apiBase = window.API_BASE || '/api/v1';
            const res = await fetch(`${apiBase}/reports/profile/${encodeURIComponent(hash)}`);
            if (!res.ok) return;
            const p = await res.json();
            const payload = {
                level: _resolveLevelFromAny(p.badge_level),
                progressLabelKey: p.tier && p.tier.progress && p.tier.progress.label_key,
                lives: Number.isFinite(p.lives_saved_total) ? p.lives_saved_total : 0,
                reports: Number.isFinite(p.report_count) ? p.report_count : 0,
                responded: Number.isFinite(p.responded_count) ? p.responded_count : 0,
            };
            // Update the cache so the chip + rewards page stay in sync.
            try { sessionStorage.setItem('crisp_home_badge_v2', JSON.stringify(payload)); } catch (_) {}
            _paintRewardsPage(payload);
        } catch (_) {}
    }

    function _openRewardsStage() {
        // Read cache for instant paint, then go to the stage, then
        // refresh in the background.
        let cached = null;
        try { cached = JSON.parse(sessionStorage.getItem('crisp_home_badge_v2') || 'null'); } catch (_) {}
        _paintRewardsPage(cached || { level: 'T1_SCOUT' });
        try {
            if (typeof window.goToStage === 'function') window.goToStage('stage-rewards');
        } catch (_) {}
        // Background refresh — no await; the cache paint is good enough.
        _refreshRewardsFromServer();
    }

    function _wireRewardsNav() {
        // Home #btn-rewards opens the rewards stage.
        const rewardsBtn = document.getElementById('btn-rewards');
        if (rewardsBtn && !rewardsBtn.__wired) {
            rewardsBtn.__wired = true;
            rewardsBtn.addEventListener('click', _openRewardsStage);
        }
        // Back button returns to home.
        const back = document.getElementById('btn-rewards-back');
        if (back && !back.__wired) {
            back.__wired = true;
            back.addEventListener('click', () => {
                try { if (typeof window.goToStage === 'function') window.goToStage('stage-home'); } catch (_) {}
            });
        }
        // Rewards page "Open Badge Studio" button — gated on tier.
        const openStudio = document.getElementById('btn-rewards-open-studio');
        if (openStudio && !openStudio.__wired) {
            openStudio.__wired = true;
            openStudio.addEventListener('click', () => {
                // openBadgeStudio() enforces its own T3+ lock + toast.
                try {
                    if (typeof window.openBadgeStudio === 'function') window.openBadgeStudio();
                } catch (_) {}
            });
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
        // May 2026 (home redesign v6, ask #6): operator wants the
        // count visible by default — "show the default number of
        // reports submitted ... to make reporting history more visible".
        // The chip used to hide when count===0; now it always paints
        // the raw number (no parentheses — the chip's mint pill chrome
        // is enough framing). Painter is idempotent so re-renders on
        // every submission flip the count without flicker.
        span.textContent = String(count);
        span.removeAttribute('hidden');
    }

    // PWA install icon — always visible until `display-mode: standalone`
    // matches (i.e. the app has been added to home screen).
    function _wireInstallIcon() {
        const btn = document.getElementById('btn-home-install-icon');
        if (!btn) return;
        function refresh() {
            // May 2026 (home redesign v6, ask #3) — the install
            // affordance was moved out of the action-tiles row into
            // the new yellow "+ Add to Homescreen" chip below the
            // footer (see _wireAddToHomescreenChip). The legacy tile
            // shell is kept in the DOM for any Playwright spec that
            // still selects #btn-home-install-icon, but it must stay
            // permanently hidden — both inline display:none AND the
            // [hidden] attribute so the CSS visibility-only treatment
            // can't resurrect it.
            btn.setAttribute('hidden', '');
            btn.style.display = 'none';
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
                tt('home_voice_hint', 'Tap the green button below to start. Or use Telegram, WhatsApp, SMS, or a phone call.'),
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
            // HAR-driven dedupe (May 2026) — see _singleFlightFetch
            // helper in app.js. Home-screen.js init races app.js's own
            // status-since fetch (and the My Reports panel's later fetch);
            // the helper coalesces all three to one network call within
            // a 10 s window. Falls back to plain fetch if app.js hasn't
            // booted yet (helper not on window).
            const dedupedFetch = (typeof window !== 'undefined' && window.__crispSingleFlightFetch) || fetch;
            const res = await dedupedFetch(`${apiBase}/reports/device/${encodeURIComponent(hash)}/status-since?since=1970-01-01T00:00:00Z`);
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
            // route through window._resolveMediaUrl so any
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
        // new wirings.
        _wireInstallIcon();
        _wireHomeVoice();
        _wireLoginIcon();
        _wireUtilityFooter();
        _paintIdentityBar();
        // v6 (May 2026, ask #3) — Add-to-Homescreen yellow chip below
        // the footer. Wires the InstallPrompt module to the new
        // #btn-home-add2hs chip; idempotent if init runs twice.
        try { _wireAddToHomescreenChip(); } catch (_) {}
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

        // "Verified Reports Nearby" intel module — fires AFTER the
        // main home paint so it doesn't block first-paint. Module is
        // self-hiding when offline / no cached GPS / API down (see
        // nearby.js for the behaviour matrix).
        try {
            if (window.NearbyIntel && typeof window.NearbyIntel.boot === 'function') {
                window.NearbyIntel.boot('#home-nearby-intel');
            }
        } catch (e) { /* best-effort */ }

        // Re-fetch nearby intel when connectivity returns. The module
        // itself hides on offline transitions; this listener pulls
        // fresh data on the online-edge so the user gets up-to-date
        // info without manually reloading.
        window.addEventListener('online', () => {
            try {
                if (window.NearbyIntel && typeof window.NearbyIntel.boot === 'function') {
                    window.NearbyIntel.boot('#home-nearby-intel');
                }
            } catch (_) { /* ignore */ }
        });
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
        // exposed for app.js to call after _submittedCache
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
