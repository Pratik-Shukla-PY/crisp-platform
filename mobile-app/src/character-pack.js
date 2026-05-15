/**
 * CRISP Character Pack — Badge Studio responder caricatures.
 *
 * Phase 2.4 (May 2026) — second pass.
 *   * Dropped the 4 comic-archetype silhouettes (Caped Guardian / Sky
 *     Sentinel / Iron Ally / Beacon Light). The operator's plan: keep
 *     the badge identity humanitarian-grade, not pop-culture.
 *   * Refined the 4 first-responder archetypes (Field Medic /
 *     Search-Rescue / Rescue Swimmer / Rescue Pilot) with a finer
 *     2.5-px stroke (was 6 px), tighter linework, and culturally-
 *     neutral details (no US-coded gear, no national-flag colours;
 *     attire reads as international humanitarian aid).
 *   * Phase 2.6 — tier-gated character: each character now carries a
 *     ``unlocks_at`` tier id. The Badge Studio picker can grey out
 *     characters the user's tier hasn't unlocked yet, and the
 *     default character changes with the user's tier.
 *
 * Why ORIGINAL caricatures: Apache-2.0 + UNDP "no proprietary deps".
 * These 4 silhouettes are CRISP-authored generic archetypes — heroic
 * vibes, zero trademark risk. All 4 ship as base64-friendly inline SVG
 * so Canvas can decode + paint via ``new Image()`` + ``drawImage()``.
 *
 * Pattern mirrors `components/icon-pack.js` — single-color foreground
 * via `currentColor` so the tier gradient applies at paint time.
 *
 * The viewBox is 240×240 — square + centered on the figure so the
 * Canvas circle-clip lands on shoulders/torso for the photo-like crop.
 *
 * Total bundle ≈ 18 KB — well under the 50 KB precache budget (down
 * from ~30 KB pre-Phase-2.4 because we shed 4 entries).
 */
(function () {
    'use strict';

    // Phase 2.4: finer stroke for higher fidelity. The badge studio
    // canvas renders at ~324-px radius via image-scaling; a 2.5-px
    // stroke at 240-px viewBox lands at ~3.4-px on-screen — sharp
    // without losing readability at the 72-px picker thumbnail size.
    const _STROKE = 2.5;

    function svg(inner) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" `
            + `fill="none" stroke="currentColor" stroke-width="${_STROKE}" `
            + `stroke-linecap="round" stroke-linejoin="round" `
            + `width="100%" height="100%" aria-hidden="true">${inner}</svg>`;
    }

    // ── First-responder archetypes (4) ─────────────────────────────
    //
    // Each character reads as an international humanitarian aid
    // worker, not a national-services badge. Attire choices:
    //   * Field Medic — head wrap (works across regions, signals
    //     ground operations), relief vest with subtle cross emblem.
    //   * Search & Rescue — utility helmet with chin strap, harness
    //     visible at chest, gloved hands. No US-axe iconography.
    //   * Rescue Swimmer — fitted wet-vest, mask pushed up, no
    //     "American beach" visor cap.
    //   * Rescue Pilot — visor flipped up so the face reads as a
    //     real person, comms boom mic, flight harness.

    /** Field Medic — relief-aid worker with shoulder pack + cross emblem. */
    const FIELD_MEDIC = svg(
        // Backpack straps (subtle, behind body).
        `<path d="M64 105 L62 215 M176 105 L178 215" stroke-width="3.5"/>`
        // Body — relief-vest with rounded shoulders.
        + `<path d="M72 100 Q72 95 78 95 L162 95 Q168 95 168 100 L172 220 Q172 224 168 224 L72 224 Q68 224 68 220 Z" fill="currentColor" fill-opacity="0.26"/>`
        // Vest pockets — two large, cargo style.
        + `<rect x="84" y="155" width="32" height="36" rx="3" fill="currentColor" fill-opacity="0.18"/>`
        + `<rect x="124" y="155" width="32" height="36" rx="3" fill="currentColor" fill-opacity="0.18"/>`
        // Medical cross emblem — chest, modest scale (humanitarian, not military).
        + `<path d="M114 115 L126 115 L126 127 L138 127 L138 139 L126 139 L126 151 L114 151 L114 139 L102 139 L102 127 L114 127 Z" fill="currentColor" fill-opacity="0.82"/>`
        // Head — softer oval (no rigid circle).
        + `<ellipse cx="120" cy="62" rx="26" ry="29" fill="currentColor" fill-opacity="0.28"/>`
        // Head wrap — culturally-neutral fabric drape over crown +
        // around back of neck; reads internationally.
        + `<path d="M94 60 Q94 30 120 30 Q146 30 146 60 L150 78 Q146 80 142 75 L140 70 Q124 78 100 70 L98 75 Q94 80 90 78 Z" fill="currentColor" fill-opacity="0.38"/>`
        // Backpack top peek.
        + `<path d="M72 92 L168 92 L165 102 L75 102 Z" fill="currentColor" fill-opacity="0.34"/>`
    );

    /** Search & Rescue — utility helmet + harness + gloved hands (no axe). */
    const SEARCH_RESCUE = svg(
        // Body — work jacket with reflective bands.
        `<path d="M78 100 Q78 96 82 96 L158 96 Q162 96 162 100 L170 220 Q170 224 166 224 L74 224 Q70 224 70 220 Z" fill="currentColor" fill-opacity="0.28"/>`
        // Reflective bands.
        + `<path d="M82 148 L160 148 M85 175 L157 175" stroke-width="2"/>`
        // Harness — chest carabiner + cross straps.
        + `<path d="M100 100 L120 138 L140 100" stroke-width="3"/>`
        + `<circle cx="120" cy="142" r="6" fill="currentColor" fill-opacity="0.68"/>`
        + `<path d="M95 138 L120 142 L145 138" stroke-width="2.5"/>`
        // Gloved hands resting at hips.
        + `<path d="M72 195 Q66 198 70 210 Q78 212 84 205 Z" fill="currentColor" fill-opacity="0.36"/>`
        + `<path d="M168 195 Q174 198 170 210 Q162 212 156 205 Z" fill="currentColor" fill-opacity="0.36"/>`
        // Helmet — rounded utility, chin-strap visible.
        + `<path d="M86 68 Q120 32 154 68" fill="currentColor" fill-opacity="0.42"/>`
        + `<path d="M70 68 L170 68 L166 80 L74 80 Z" fill="currentColor" fill-opacity="0.55"/>`
        // Chin-strap — two short lines from helmet edge down to jaw.
        + `<path d="M90 78 L100 95 M150 78 L140 95" stroke-width="2.5"/>`
        // Helmet front emblem — small badge (no flag).
        + `<rect x="112" y="40" width="16" height="16" rx="2" fill="currentColor" fill-opacity="0.78"/>`
    );

    /** Rescue Swimmer — wet-vest + mask pushed up + lanyard whistle. */
    const RESCUE_SWIMMER = svg(
        // Body — fitted wet-vest with subtle ribbing.
        `<path d="M84 100 Q84 96 88 96 L152 96 Q156 96 156 100 L160 218 Q160 222 156 222 L84 222 Q80 222 80 218 Z" fill="currentColor" fill-opacity="0.30"/>`
        // Vest seam down center + chest panel highlight.
        + `<path d="M120 100 L120 218" stroke-width="2"/>`
        + `<path d="M94 115 L146 115 M94 135 L146 135" stroke-width="1.5"/>`
        // Lanyard + whistle (centred, humanitarian-neutral).
        + `<path d="M110 96 L120 145 L130 96" stroke-width="1.8"/>`
        + `<rect x="114" y="143" width="12" height="10" rx="2" fill="currentColor" fill-opacity="0.72"/>`
        // Head — softer oval, slight chin definition.
        + `<ellipse cx="120" cy="66" rx="26" ry="28" fill="currentColor" fill-opacity="0.30"/>`
        // Hairline arc (just a hint — culturally neutral).
        + `<path d="M96 60 Q120 44 144 60" stroke-width="2"/>`
        // Goggles pushed up onto forehead — two lens cups + strap.
        + `<path d="M94 50 L146 50 L144 56 L96 56 Z" fill="currentColor" fill-opacity="0.40"/>`
        + `<circle cx="106" cy="46" r="6" fill="currentColor" fill-opacity="0.62"/>`
        + `<circle cx="134" cy="46" r="6" fill="currentColor" fill-opacity="0.62"/>`
        + `<path d="M94 48 Q88 44 90 38 M146 48 Q152 44 150 38" stroke-width="1.5"/>`
    );

    /** Rescue Pilot — flight suit + visor-up helmet + comms mic. */
    const RESCUE_PILOT = svg(
        // Soft rotor blur lines (3 horizontal at top — narrower than before).
        `<path d="M30 28 L210 28 M40 18 L200 18 M50 38 L190 38" stroke-width="1.8" stroke-dasharray="6,4"/>`
        // Body — flight suit with two chest panels.
        + `<path d="M82 100 Q82 96 86 96 L154 96 Q158 96 158 100 L168 220 Q168 224 164 224 L76 224 Q72 224 72 220 Z" fill="currentColor" fill-opacity="0.28"/>`
        // Chest panel seams.
        + `<path d="M120 96 L120 158" stroke-width="2"/>`
        // Utility belt + two pouches (smaller than pre-Phase-2.4).
        + `<path d="M78 158 L162 158" stroke-width="3.5"/>`
        + `<rect x="92" y="162" width="20" height="14" rx="2" fill="currentColor" fill-opacity="0.50"/>`
        + `<rect x="128" y="162" width="20" height="14" rx="2" fill="currentColor" fill-opacity="0.50"/>`
        // Patch on left chest (subtle, no national insignia).
        + `<rect x="92" y="112" width="20" height="20" rx="2" fill="currentColor" fill-opacity="0.42"/>`
        // Helmet — visor FLIPPED UP so the wearer's face shows
        // (more humanizing than the pre-Phase-2.4 mirrored visor).
        + `<path d="M88 72 Q120 36 152 72" fill="currentColor" fill-opacity="0.38"/>`
        + `<path d="M88 38 Q88 28 100 28 L140 28 Q152 28 152 38 L152 50 L88 50 Z" fill="currentColor" fill-opacity="0.62"/>`
        // Face (just hint — softer than the rigid circle pre-fix).
        + `<ellipse cx="120" cy="72" rx="22" ry="22" fill="currentColor" fill-opacity="0.20"/>`
        // Boom mic — slim curve from helmet to mouth.
        + `<path d="M150 78 Q166 86 162 102" stroke-width="2"/>`
        + `<circle cx="162" cy="102" r="4" fill="currentColor" fill-opacity="0.85"/>`
    );

    // ── Character registry ─────────────────────────────────────────

    /**
     * Each entry: ``{ slug, label_en, theme, svg, gradient, unlocks_at }``
     *
     * ``unlocks_at`` (Phase 2.6) — the V4 tier id at which this
     * character becomes selectable in the Badge Studio picker.
     * Lower-tier reporters see higher-tier characters but they
     * appear muted + with a "Reach <tier> to unlock" label. The
     * BS picker also auto-defaults to the highest-unlocked
     * character when the studio first opens.
     *
     *   T1_SCOUT       → Field Medic       (ground operations,
     *                                       first-responder vibe)
     *   T2_SIGNAL      → Search & Rescue   (the reporter is now
     *                                       part of the response loop)
     *   T3_CHANGEMAKER → Rescue Swimmer    (action-coded; analyst
     *                                       has confirmed real
     *                                       impact)
     *   T4_LIFEKEEPER  → Rescue Pilot      (highest-impact gear;
     *                                       the most stylised hero
     *                                       silhouette in the pack)
     */
    const CHARACTERS = [
        { slug: 'field_medic',    label_en: 'Field Medic',     theme: 'responder', svg: FIELD_MEDIC,    gradient: ['#46DFB1', '#80EE98'], unlocks_at: 'T1_SCOUT' },
        { slug: 'search_rescue',  label_en: 'Search & Rescue', theme: 'responder', svg: SEARCH_RESCUE,  gradient: ['#f59e0b', '#80EE98'], unlocks_at: 'T2_SIGNAL' },
        { slug: 'rescue_swimmer', label_en: 'Rescue Swimmer',  theme: 'responder', svg: RESCUE_SWIMMER, gradient: ['#09D1C7', '#46DFB1'], unlocks_at: 'T3_CHANGEMAKER' },
        { slug: 'rescue_pilot',   label_en: 'Rescue Pilot',    theme: 'responder', svg: RESCUE_PILOT,   gradient: ['#fcd34d', '#f59e0b'], unlocks_at: 'T4_LIFEKEEPER' },
    ];

    // Default character — the lowest-tier responder, available to everyone.
    // The Badge Studio's open path may override this to the user's
    // current-tier character (see Phase 2.6 wiring in badge-studio.js).
    const DEFAULT_SLUG = 'field_medic';

    /**
     * Return a Promise<HTMLImageElement> ready to drawImage(). The
     * SVG is coloured to `color` (any CSS color) via a string-replace
     * on the `currentColor` placeholder.
     */
    function loadCharacterAsImage(slug, color) {
        const c = CHARACTERS.find((x) => x.slug === slug) ||
                  CHARACTERS.find((x) => x.slug === DEFAULT_SLUG);
        const coloured = c.svg.replace(/currentColor/g, color || '#80EE98');
        const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(coloured);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(e);
            img.src = url;
        });
    }

    /** Synchronous accessor for the picker UI — returns the raw SVG
     *  string ready to drop into innerHTML on a thumbnail tile. */
    function getCharacterPreviewHtml(slug, color) {
        const c = CHARACTERS.find((x) => x.slug === slug) ||
                  CHARACTERS.find((x) => x.slug === DEFAULT_SLUG);
        return c.svg.replace(/currentColor/g, color || '#46DFB1');
    }

    function getCharacterMeta(slug) {
        return CHARACTERS.find((x) => x.slug === slug) ||
               CHARACTERS.find((x) => x.slug === DEFAULT_SLUG);
    }

    function listCharacters() {
        return CHARACTERS.slice();
    }

    /**
     * Phase 2.6 — pick the canonical default character for a tier.
     * Used by badge-studio.js to choose the auto-selected silhouette
     * the FIRST time the studio opens at a given tier.
     */
    function defaultForTier(tierId) {
        const TIER_ORDER = ['T1_SCOUT', 'T2_SIGNAL', 'T3_CHANGEMAKER', 'T4_LIFEKEEPER'];
        const userIdx = Math.max(0, TIER_ORDER.indexOf(tierId || 'T1_SCOUT'));
        // Walk DOWN from the user's tier until we find a character
        // they've unlocked. T1 reporters fall to `field_medic`; T4
        // reporters get the pilot.
        for (let i = userIdx; i >= 0; i--) {
            const want = TIER_ORDER[i];
            const c = CHARACTERS.find((x) => x.unlocks_at === want);
            if (c) return c.slug;
        }
        return DEFAULT_SLUG;
    }

    /** Phase 2.6 — is `slug` unlocked for a reporter at `tierId`? */
    function isUnlockedAt(slug, tierId) {
        const TIER_ORDER = ['T1_SCOUT', 'T2_SIGNAL', 'T3_CHANGEMAKER', 'T4_LIFEKEEPER'];
        const c = CHARACTERS.find((x) => x.slug === slug);
        if (!c) return false;
        const needIdx = TIER_ORDER.indexOf(c.unlocks_at);
        const haveIdx = TIER_ORDER.indexOf(tierId || 'T1_SCOUT');
        return haveIdx >= 0 && haveIdx >= needIdx;
    }

    window.crispCharacterPack = {
        DEFAULT_SLUG,
        list: listCharacters,
        meta: getCharacterMeta,
        loadAsImage: loadCharacterAsImage,
        previewHtml: getCharacterPreviewHtml,
        defaultForTier: defaultForTier,
        isUnlockedAt: isUnlockedAt,
    };
})();
