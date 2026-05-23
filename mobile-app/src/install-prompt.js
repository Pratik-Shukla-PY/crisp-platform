// ──────────────────────────────────────────────────────────────────────────
// CRISP — PWA install prompt helper.
//
// Wraps the platform-specific "Add to Home Screen" UX in one helper so the
// landing card just calls `InstallPrompt.show()` regardless of OS.
//
// Three platforms, three flows:
//   1. Chrome / Edge / Android-Chrome — fires `beforeinstallprompt` once
//      the page meets PWA criteria (manifest + SW + HTTPS + icons). We
//      stash the event and show our own button. On tap → call .prompt().
//   2. iOS Safari (incl. iPad)        — has no programmatic install. We
//      detect via `navigator.standalone === false` AND iOS UA, then
//      surface a slide-up sheet with the 3-step Share → Add to Home Screen
//      instruction.
//   3. Already installed              — `display-mode: standalone` matches.
//      We hide the install card entirely so we don't nag.
//
// State exposed on `window.InstallPrompt`:
//   .canInstall (bool)        — true if we can trigger an install (any platform)
//   .platform   (string)      — 'android' | 'ios' | 'desktop' | 'standalone' | 'unknown'
//   .show()                   — invoke the right flow for the current platform
//   .onChange(callback)       — fire when canInstall toggles (lets the landing
//                               card show/hide its install button reactively)
// ──────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    let _deferredPrompt = null;
    let _platform = 'unknown';
    let _canInstall = false;
    const _listeners = new Set();

    // Detect platform once at module load.
    function _detectPlatform() {
        // Already installed → don't prompt.
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
            return 'standalone';
        }
        if (window.navigator && window.navigator.standalone === true) {
            // iOS-specific signal
            return 'standalone';
        }

        const ua = (window.navigator.userAgent || '').toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) return 'ios';
        if (/android/.test(ua)) return 'android';
        return 'desktop';
    }

    _platform = _detectPlatform();

    // AUDIT 2026-05-23 (HC2 humanitarian-grade home) — default `canInstall`
    // to TRUE on every platform EXCEPT `standalone` (already installed).
    // Pre-fix, Android / Desktop / Firefox / Samsung Internet had to wait
    // for the Chromium-specific `beforeinstallprompt` to fire before the
    // button appeared — and that event NEVER fires in some browsers (FF
    // Android, in-app webviews, older Samsung Internet). The spec asks
    // for an always-visible install affordance with a universal fallback.
    //
    // The fallback sheet (`_showIosSheet` below) is no longer iOS-only:
    // it carries instructions for Safari + Chrome + Firefox + Samsung
    // Internet so tapping the button always teaches the user how to
    // install regardless of browser.
    if (_platform !== 'standalone') {
        _canInstall = true;
    }

    function _emit() {
        _listeners.forEach((cb) => {
            try { cb({ canInstall: _canInstall, platform: _platform }); }
            catch (e) { console.warn('[InstallPrompt] listener threw', e); }
        });
    }

    // Listen for the Chrome / Edge / Android-Chrome install signal.
    window.addEventListener('beforeinstallprompt', (e) => {
        // Suppress the browser's mini-infobar — we want to show our
        // own button instead, in our own UX.
        e.preventDefault();
        _deferredPrompt = e;
        _canInstall = true;
        // Override platform if it's not iOS — we have hard proof of a
        // native install path now.
        if (_platform !== 'ios') _platform = 'android';  // close-enough label
        _emit();
        console.log('[InstallPrompt] beforeinstallprompt captured');
    });

    // After install, browsers fire `appinstalled`. Hide our button.
    window.addEventListener('appinstalled', () => {
        _deferredPrompt = null;
        _canInstall = false;
        _platform = 'standalone';
        _emit();
        console.log('[InstallPrompt] app installed');
    });

    // Universal Add-to-Home-Screen instructions sheet.
    // AUDIT 2026-05-23 (HC2) — renamed from `_showIosSheet` because it
    // now serves Safari iOS + Chrome + Firefox + Samsung Internet users,
    // not just iPhone. Per-browser instruction blocks are shown/hidden
    // based on platform detection. The sheet is the universal fallback
    // when `beforeinstallprompt` doesn't fire.
    function _showInstallSheet() {
        const existing = document.getElementById('ios-install-sheet');
        if (existing) { existing.style.display = 'flex'; return; }

        const sheet = document.createElement('div');
        sheet.id = 'ios-install-sheet';      // keep legacy id for CSS continuity
        sheet.className = 'ios-install-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'iis-title');

        // Detect platform variant fresh in case UA spoofing changed since boot.
        const ua = (window.navigator.userAgent || '').toLowerCase();
        const isIos = /iphone|ipad|ipod/.test(ua);
        const isAndroid = /android/.test(ua);
        const isSamsung = /samsungbrowser/.test(ua);
        const isFirefox = /firefox|fxios/.test(ua);

        // Title + first-line instruction picks the right active step.
        let primaryStep = '';
        if (isIos) {
            primaryStep = `
                <li class="iis-active-step">
                    <span class="iis-step-num">1</span>
                    <span class="iis-step-text">
                        Tap the Share button
                        <span class="iis-icon"><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i></span>
                        in Safari, then <strong>Add to Home Screen</strong>.
                    </span>
                </li>`;
        } else if (isSamsung) {
            primaryStep = `
                <li class="iis-active-step">
                    <span class="iis-step-num">1</span>
                    <span class="iis-step-text">
                        Tap the menu button (☰) in Samsung Internet, then
                        <strong>Add page to → Home screen</strong>.
                    </span>
                </li>`;
        } else if (isFirefox) {
            primaryStep = `
                <li class="iis-active-step">
                    <span class="iis-step-num">1</span>
                    <span class="iis-step-text">
                        Tap the menu (⋮) in Firefox, then
                        <strong>Install</strong> or <strong>Add to Home Screen</strong>.
                    </span>
                </li>`;
        } else if (isAndroid) {
            primaryStep = `
                <li class="iis-active-step">
                    <span class="iis-step-num">1</span>
                    <span class="iis-step-text">
                        Tap the menu (⋮) in Chrome, then
                        <strong>Install app</strong>.
                    </span>
                </li>`;
        } else {
            primaryStep = `
                <li class="iis-active-step">
                    <span class="iis-step-num">1</span>
                    <span class="iis-step-text">
                        Click the install icon in your browser's address bar,
                        or open the menu → <strong>Install CRISP</strong>.
                    </span>
                </li>`;
        }

        sheet.innerHTML = `
            <div class="iis-card" role="document">
                <button class="iis-close" aria-label="Close" data-i18n-aria-label="lang_picker_close">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
                <h3 class="iis-title" id="iis-title" data-i18n="install_sheet_title">
                    Add CRISP to your home screen
                </h3>
                <p class="iis-sub" data-i18n="install_sheet_sub">
                    Works offline. Reports save instantly. Faster reporting.
                </p>
                <ol class="iis-steps">
                    ${primaryStep}
                </ol>
                <p class="iis-note" data-i18n="install_sheet_note">
                    CRISP will then work like any other app — even when offline.
                </p>
            </div>
        `;
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet || e.target.closest('.iis-close')) {
                sheet.style.display = 'none';
            }
        });
        document.body.appendChild(sheet);
    }

    async function _show() {
        // Universal flow: prefer the native prompt if Chromium cached it,
        // otherwise open the instructional sheet — works on every browser.
        if (_deferredPrompt) {
            _deferredPrompt.prompt();
            const result = await _deferredPrompt.userChoice;
            _deferredPrompt = null;
            // Keep canInstall true on dismiss so the user can retry; flip
            // false only on appinstalled (handled by the event listener
            // above).
            _emit();
            return result;
        }
        // Fallback: any platform without a cached prompt → instructional sheet.
        _showInstallSheet();
        return { outcome: 'instructions_shown', platform: _platform };
    }

    function _onChange(cb) {
        _listeners.add(cb);
        // Fire immediately with current state.
        try { cb({ canInstall: _canInstall, platform: _platform }); }
        catch (e) { console.warn(e); }
        return () => _listeners.delete(cb);
    }

    window.InstallPrompt = {
        get canInstall() { return _canInstall; },
        get platform() { return _platform; },
        show: _show,
        onChange: _onChange,
    };
})();
