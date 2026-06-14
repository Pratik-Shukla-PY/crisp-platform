// ── voice-readout.js ─────────────────────────────────────────────────
// CRISP UI v3 redesign - Phase 5.
//
// Purpose: every <element data-voice="<i18n-key>"> in the DOM gets a
// 🔊 button auto-prepended. Tapping reads the question text aloud in
// the user's currently-active language using the Web Speech API.
//
// Why we need this: low-literacy users in panic can't read icons or
// labels. UNDP rubric Q3 (webinar) treats anonymous + voice-first as
// core requirements. This module unlocks the lowest-literacy band.
//
// Implementation:
//   - Web Speech API (synthesis) - present in every modern browser
//     (Chrome, Safari, Firefox, Edge, Samsung Internet). Uses the
//     device's pre-installed TTS voices, so it works offline.
//   - Lang code mapping: app.js's `state.lang` (e.g. "en", "kn", "hi")
//     → BCP-47 speech code (e.g. "en-IN", "kn-IN"). Falls back to
//     plain language tag if no regional voice is found.
//   - Graceful no-op when SpeechSynthesis is unavailable (very old
//     browsers); the 🔊 button is hidden in that case.
//
// Usage in markup:
//   <h2 data-i18n="v4_q_damage" data-voice="v4_q_damage">…</h2>
//
// The data-voice value MUST match an existing i18n key so the spoken
// text always matches what the user sees on screen. The module looks
// up the key via `window.t(key)` (defined in app.js).

(function () {
    'use strict';

    // BCP-47 mapping for the speech-synthesis voice. Falls back to the
    // bare language code if no regional variant is configured.
    const SPEECH_MAP = {
        en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN', ta: 'ta-IN', bn: 'bn-IN',
        ur: 'ur-PK', ar: 'ar-SA', fr: 'fr-FR', es: 'es-ES', ru: 'ru-RU',
        zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', th: 'th-TH', vi: 'vi-VN',
        id: 'id-ID', ms: 'ms-MY', sw: 'sw-KE', am: 'am-ET', pt: 'pt-BR',
        de: 'de-DE', it: 'it-IT', pl: 'pl-PL', ro: 'ro-RO', el: 'el-GR',
        uk: 'uk-UA', tr: 'tr-TR', fa: 'fa-IR', he: 'he-IL',
    };

    function _isSupported() {
        return typeof window !== 'undefined'
            && typeof window.speechSynthesis !== 'undefined'
            && typeof window.SpeechSynthesisUtterance !== 'undefined';
    }

    function _getActiveLang() {
        try { return (window.state && window.state.lang) || 'en'; }
        catch (_) { return 'en'; }
    }

    function _getActiveSpeechCode() {
        const lang = _getActiveLang();
        return SPEECH_MAP[lang] || lang;
    }

    function _resolveVoice(speechCode) {
        // Find a voice that matches the BCP-47 code or its bare
        // language prefix. Some platforms ship region-specific voices
        // only (e.g. 'en-US' but no 'en-IN'); we accept any 'en-*'.
        const voices = window.speechSynthesis.getVoices() || [];
        let match = voices.find(v => v.lang === speechCode);
        if (!match) {
            const bare = speechCode.split('-')[0];
            match = voices.find(v => v.lang.startsWith(bare));
        }
        return match || null;
    }

    function speakText(text, lang) {
        if (!_isSupported() || !text) return;
        try {
            // Cancel any in-flight utterance so a second tap on a
            // different question doesn't queue.
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            const speechCode = lang ? (SPEECH_MAP[lang] || lang) : _getActiveSpeechCode();
            u.lang = speechCode;
            const voice = _resolveVoice(speechCode);
            if (voice) u.voice = voice;
            u.rate = 0.95;     // a touch slower for clarity
            u.pitch = 1.0;
            u.volume = 1.0;
            window.speechSynthesis.speak(u);
        } catch (e) {
            console.warn('[voice-readout] speak failed:', e);
        }
    }

    function _resolveText(el) {
        const key = el.getAttribute('data-voice');
        if (!key) return '';
        // Prefer the live i18n lookup - that way switching language
        // re-speaks in the new language without re-rendering.
        if (typeof window.t === 'function') {
            try {
                const v = window.t(key);
                if (v && v !== key) return v;
            } catch (_) {}
        }
        // Fallback to whatever text is currently rendered in the
        // element (i18n already applied via data-i18n).
        return (el.textContent || '').trim();
    }

    function _attachButton(el) {
        // Don't double-attach.
        if (el.dataset.voiceWired === '1') return;
        if (!_isSupported()) {
            // Hide the visual hint to avoid teasing a feature we can't deliver.
            return;
        }
        el.dataset.voiceWired = '1';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'voice-readout-btn';
        btn.setAttribute('aria-label', 'Read aloud');
        btn.title = 'Read aloud';
        btn.innerHTML = '<i class="fa-solid fa-volume-high" aria-hidden="true"></i>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const txt = _resolveText(el);
            speakText(txt);
            // Visual feedback: pulse the button while speaking.
            btn.classList.add('voice-readout-speaking');
            const utt = window.speechSynthesis;
            const onEnd = () => {
                btn.classList.remove('voice-readout-speaking');
            };
            // SpeechSynthesisUtterance fires onend when finished. Hook it
            // generically by polling speaking - simpler than wiring through
            // speakText's local Utterance var.
            const poll = setInterval(() => {
                if (!utt.speaking) {
                    clearInterval(poll);
                    onEnd();
                }
            }, 250);
            // Safety: clear after 30s no matter what.
            setTimeout(() => { clearInterval(poll); onEnd(); }, 30_000);
        });
        // Insert after the label text (so the question reads naturally).
        el.appendChild(btn);
    }

    function _scanAndAttach(root) {
        const scope = root || document;
        const targets = scope.querySelectorAll('[data-voice]');
        targets.forEach(_attachButton);
    }

    // Auto-init on DOMContentLoaded. Re-scan whenever a new question
    // gets injected (e.g. v4 dynamic carousel). Capture-flow pages
    // dispatch a `crisp-stage-rendered` event after their setup runs.
    function init() {
        _scanAndAttach();
        document.addEventListener('crisp-stage-rendered', () => _scanAndAttach());
        // Also re-attach after language switches so the spoken text
        // resolves to the newly-active locale.
        document.addEventListener('crisp-language-changed', () => {
            // Buttons stay; only the resolved text changes (it's looked
            // up live in _resolveText). No-op besides logging.
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public surface - used by other modules + e2e tests.
    window.VoiceReadout = {
        speak: speakText,
        rescan: _scanAndAttach,
        isSupported: _isSupported,
        // For tests: expose the BCP-47 mapping.
        _speechMap: SPEECH_MAP,
    };
})();
