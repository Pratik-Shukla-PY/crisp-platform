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

    // iOS can always "install" via Add-to-Home-Screen (manual). Android
    // depends on `beforeinstallprompt` firing; desktop Chrome same.
    if (_platform === 'ios') {
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

    // Show iOS Add-to-Home-Screen instructions sheet.
    function _showIosSheet() {
        const existing = document.getElementById('ios-install-sheet');
        if (existing) { existing.style.display = 'flex'; return; }

        const sheet = document.createElement('div');
        sheet.id = 'ios-install-sheet';
        sheet.className = 'ios-install-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.innerHTML = `
            <div class="iis-card">
                <button class="iis-close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <h3 class="iis-title">Install CRISP on your iPhone</h3>
                <ol class="iis-steps">
                    <li>
                        <span class="iis-step-num">1</span>
                        <span class="iis-step-text">
                            Tap the Share button
                            <span class="iis-icon"><i class="fa-solid fa-arrow-up-from-bracket"></i></span>
                            at the bottom of Safari.
                        </span>
                    </li>
                    <li>
                        <span class="iis-step-num">2</span>
                        <span class="iis-step-text">
                            Scroll and tap
                            <strong>Add to Home Screen</strong>
                            <span class="iis-icon"><i class="fa-solid fa-square-plus"></i></span>
                        </span>
                    </li>
                    <li>
                        <span class="iis-step-num">3</span>
                        <span class="iis-step-text">
                            Tap <strong>Add</strong> in the top-right corner.
                        </span>
                    </li>
                </ol>
                <p class="iis-note">
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
        if (_platform === 'ios') {
            _showIosSheet();
            return { outcome: 'ios_instructions_shown' };
        }
        if (_deferredPrompt) {
            _deferredPrompt.prompt();
            const result = await _deferredPrompt.userChoice;
            _deferredPrompt = null;
            _canInstall = false;
            _emit();
            return result;
        }
        return { outcome: 'no_prompt_available' };
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
