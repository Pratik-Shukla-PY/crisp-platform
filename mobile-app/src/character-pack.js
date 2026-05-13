/**
 * CRISP Character Pack — Badge Studio hero caricatures.
 *
 * 8 original stylised silhouettes — 4 comic-style superhero archetypes
 * + 4 real-world first-responder archetypes. Used by badge-studio.js
 * to populate the "Choose your hero" picker on stage-badge-studio.
 *
 * Why ORIGINAL caricatures: Batman / Superman / Black Panther etc. are
 * trademarked. CRISP is Apache-2.0 + UNDP "no proprietary deps". These
 * 8 silhouettes are CRISP-authored generic archetypes — heroic vibes,
 * zero infringement risk. All 8 ship as base64-friendly inline SVG so
 * Canvas can decode + paint via `new Image()` + `drawImage()`.
 *
 * Pattern mirrors `components/icon-pack.js` — single-color foreground
 * via `currentColor` so the tier gradient applies at paint time. Each
 * silhouette uses a chunky 6-px stroke (vs the chip icon pack's 2-px)
 * because they're rendered at ~324-px radius on the share canvas.
 *
 * The viewBox is 240×240 — square + centered on the figure so the
 * Canvas circle-clip lands on shoulders/torso for the photo-like crop.
 *
 * Total bundle ≈ 30 KB — under the 50 KB precache budget.
 */
(function () {
    'use strict';

    const _STROKE = 6;

    function svg(inner) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" `
            + `fill="none" stroke="currentColor" stroke-width="${_STROKE}" `
            + `stroke-linecap="round" stroke-linejoin="round" `
            + `width="100%" height="100%" aria-hidden="true">${inner}</svg>`;
    }

    // ── Comic archetypes (4) ───────────────────────────────────────

    /** Caped Guardian — hooded head, eye-mask, broad cape. */
    const CAPED_GUARDIAN = svg(
        // Cape (back) — two flowing curves from shoulders outward.
        `<path d="M60 95 Q30 150 50 220 L100 200 L100 100 Z" fill="currentColor" fill-opacity="0.15"/>`
        + `<path d="M180 95 Q210 150 190 220 L140 200 L140 100 Z" fill="currentColor" fill-opacity="0.15"/>`
        // Body (torso trapezoid).
        + `<path d="M85 100 L155 100 L165 220 L75 220 Z" fill="currentColor" fill-opacity="0.25"/>`
        // Chest emblem — diamond.
        + `<path d="M120 130 L135 150 L120 175 L105 150 Z" fill="currentColor" fill-opacity="0.55"/>`
        // Head — circle with hood line.
        + `<circle cx="120" cy="70" r="32" fill="currentColor" fill-opacity="0.30"/>`
        + `<path d="M88 70 Q88 38 120 38 Q152 38 152 70"/>`
        // Eye-mask band.
        + `<path d="M95 65 L145 65" stroke-width="9"/>`
    );

    /** Sky Sentinel — flying pose (horizontal), arm forward, cape trailing. */
    const SKY_SENTINEL = svg(
        // Trailing cape (behind body).
        `<path d="M30 140 Q70 130 110 140 L130 175 L40 175 Z" fill="currentColor" fill-opacity="0.20"/>`
        // Body — horizontal flight pose.
        + `<path d="M70 120 L170 110 L195 130 L180 145 L70 155 Z" fill="currentColor" fill-opacity="0.30"/>`
        // Forward arm (fist out, leading).
        + `<path d="M195 130 L225 125 L220 145 L195 140 Z" fill="currentColor" fill-opacity="0.45"/>`
        // Head + helmet line.
        + `<circle cx="185" cy="115" r="22" fill="currentColor" fill-opacity="0.30"/>`
        + `<path d="M165 113 Q165 92 185 92 Q205 92 205 113"/>`
        // Speed lines (3 short).
        + `<path d="M30 130 L55 130 M40 145 L65 145 M35 160 L60 160" stroke-width="4"/>`
    );

    /** Iron Ally — boxy armored helmet + chest plate + arc-reactor circle. */
    const IRON_ALLY = svg(
        // Body — armored trapezoid with plate seams.
        `<path d="M80 100 L160 100 L172 220 L68 220 Z" fill="currentColor" fill-opacity="0.30"/>`
        + `<path d="M80 130 L160 130 M120 100 L120 220" stroke-width="3"/>`
        // Arc reactor — central glowing circle.
        + `<circle cx="120" cy="155" r="20" fill="currentColor" fill-opacity="0.50"/>`
        + `<circle cx="120" cy="155" r="10"/>`
        // Boxy helmet.
        + `<path d="M88 38 L152 38 L160 88 L80 88 Z" fill="currentColor" fill-opacity="0.35"/>`
        // Visor slit.
        + `<path d="M95 62 L145 62 L142 72 L98 72 Z" fill="currentColor" fill-opacity="0.85"/>`
        // Shoulder pads (tabs).
        + `<path d="M65 105 L78 100 L80 118 L62 122 Z" fill="currentColor" fill-opacity="0.35"/>`
        + `<path d="M175 105 L162 100 L160 118 L178 122 Z" fill="currentColor" fill-opacity="0.35"/>`
    );

    /** Beacon Light — standing figure with radiating light rays around head. */
    const BEACON_LIGHT = svg(
        // Radiating rays (8 directions from head).
        `<path d="M120 12 L120 28 M120 152 L120 168 M48 70 L62 70 M178 70 L192 70 `
        + `M68 22 L80 32 M172 22 L160 32 M68 118 L80 108 M172 118 L160 108" stroke-width="4"/>`
        // Outer halo arc.
        + `<circle cx="120" cy="70" r="50" fill="currentColor" fill-opacity="0.08"/>`
        // Body.
        + `<path d="M88 110 L152 110 L160 220 L80 220 Z" fill="currentColor" fill-opacity="0.30"/>`
        // Chest star.
        + `<path d="M120 140 L128 158 L148 158 L132 170 L138 190 L120 178 L102 190 L108 170 L92 158 L112 158 Z" fill="currentColor" fill-opacity="0.55"/>`
        // Head.
        + `<circle cx="120" cy="70" r="28" fill="currentColor" fill-opacity="0.45"/>`
    );

    // ── First-responder archetypes (4) ──────────────────────────────

    /** Field Medic — backpack + medical cross emblem + headband. */
    const FIELD_MEDIC = svg(
        // Backpack straps (behind body).
        `<path d="M62 100 L62 215 M178 100 L178 215" stroke-width="9"/>`
        // Body (jacket).
        + `<path d="M72 95 L168 95 L172 220 L68 220 Z" fill="currentColor" fill-opacity="0.28"/>`
        // Medical cross emblem — large + centered on chest.
        + `<path d="M108 135 L132 135 L132 155 L152 155 L152 178 L132 178 L132 198 L108 198 L108 178 L88 178 L88 155 L108 155 Z" fill="currentColor" fill-opacity="0.85"/>`
        // Head.
        + `<circle cx="120" cy="60" r="28" fill="currentColor" fill-opacity="0.30"/>`
        // Headband (forehead).
        + `<path d="M93 55 L147 55" stroke-width="10"/>`
        // Backpack top.
        + `<path d="M70 88 L170 88 L165 100 L75 100 Z" fill="currentColor" fill-opacity="0.40"/>`
    );

    /** Firefighter — domed helmet with brim + jacket lapels + axe over shoulder. */
    const FIREFIGHTER = svg(
        // Axe haft (back of body — diagonal).
        `<path d="M55 70 L175 200" stroke-width="6"/>`
        // Axe head.
        + `<path d="M50 60 L78 50 L72 90 L42 78 Z" fill="currentColor" fill-opacity="0.55"/>`
        // Body — jacket with reflective stripes.
        + `<path d="M78 100 L162 100 L172 220 L68 220 Z" fill="currentColor" fill-opacity="0.30"/>`
        + `<path d="M82 150 L160 150 M85 175 L157 175" stroke-width="3"/>`
        // Jacket lapel V.
        + `<path d="M100 100 L120 130 L140 100" stroke-width="5"/>`
        // Helmet dome + brim.
        + `<path d="M85 70 Q120 22 155 70" fill="currentColor" fill-opacity="0.40"/>`
        + `<path d="M70 70 L170 70 L165 80 L75 80 Z" fill="currentColor" fill-opacity="0.55"/>`
        // Helmet badge.
        + `<rect x="108" y="36" width="24" height="22" rx="3" fill="currentColor" fill-opacity="0.75"/>`
    );

    /** Lifeguard — visor cap + whistle + float ring around torso. */
    const LIFEGUARD = svg(
        // Float ring (behind body) — ring shape.
        `<ellipse cx="120" cy="170" rx="80" ry="42" stroke-width="10"/>`
        + `<ellipse cx="120" cy="170" rx="58" ry="22" fill="currentColor" fill-opacity="0.10"/>`
        // Body (vest / shirt).
        + `<path d="M88 100 L152 100 L158 215 L82 215 Z" fill="currentColor" fill-opacity="0.30"/>`
        // Whistle on cord.
        + `<path d="M120 100 L120 130" stroke-width="3"/>`
        + `<rect x="113" y="128" width="14" height="10" rx="2" fill="currentColor" fill-opacity="0.75"/>`
        // Head.
        + `<circle cx="120" cy="65" r="28" fill="currentColor" fill-opacity="0.30"/>`
        // Visor cap (eyebrow + brim).
        + `<path d="M92 60 Q120 38 148 60 L148 70 L92 70 Z" fill="currentColor" fill-opacity="0.50"/>`
        + `<path d="M80 70 L160 70 L156 78 L84 78 Z" fill="currentColor" fill-opacity="0.65"/>`
    );

    /** Rescue Pilot — rounded helmet + visor + boom mic + rotor blur lines. */
    const RESCUE_PILOT = svg(
        // Rotor blur lines (top).
        `<path d="M20 30 L220 30 M30 18 L210 18 M50 42 L190 42" stroke-width="3"/>`
        // Body — flight suit.
        + `<path d="M82 100 L158 100 L168 220 L72 220 Z" fill="currentColor" fill-opacity="0.30"/>`
        // Belt + utility pouches.
        + `<path d="M76 160 L164 160" stroke-width="6"/>`
        + `<rect x="92" y="165" width="20" height="14" rx="2" fill="currentColor" fill-opacity="0.55"/>`
        + `<rect x="128" y="165" width="20" height="14" rx="2" fill="currentColor" fill-opacity="0.55"/>`
        // Round helmet.
        + `<circle cx="120" cy="70" r="35" fill="currentColor" fill-opacity="0.30"/>`
        // Visor.
        + `<path d="M90 65 L150 65 L148 82 L92 82 Z" fill="currentColor" fill-opacity="0.85"/>`
        // Boom mic.
        + `<path d="M148 80 Q165 85 162 100" stroke-width="3"/>`
        + `<circle cx="162" cy="100" r="5" fill="currentColor" fill-opacity="0.85"/>`
    );

    // ── Character registry ─────────────────────────────────────────

    /**
     * Each entry: { slug, label_en, theme, svg, gradient: [from, to] }
     * `gradient` tells the canvas which two colors to interpolate as
     * the foreground when painting. Aligns with tier accent palette.
     */
    const CHARACTERS = [
        // Comic archetypes — row 1.
        { slug: 'caped_guardian', label_en: 'Caped Guardian', theme: 'comic',     svg: CAPED_GUARDIAN, gradient: ['#80EE98', '#46DFB1'] },
        { slug: 'sky_sentinel',   label_en: 'Sky Sentinel',   theme: 'comic',     svg: SKY_SENTINEL,   gradient: ['#46DFB1', '#09D1C7'] },
        { slug: 'iron_ally',      label_en: 'Iron Ally',      theme: 'comic',     svg: IRON_ALLY,      gradient: ['#94a3b8', '#46DFB1'] },
        { slug: 'beacon_light',   label_en: 'Beacon Light',   theme: 'comic',     svg: BEACON_LIGHT,   gradient: ['#80EE98', '#fde68a'] },
        // First responder archetypes — row 2.
        { slug: 'field_medic',    label_en: 'Field Medic',    theme: 'responder', svg: FIELD_MEDIC,    gradient: ['#46DFB1', '#80EE98'] },
        { slug: 'firefighter',    label_en: 'Firefighter',    theme: 'responder', svg: FIREFIGHTER,    gradient: ['#f59e0b', '#80EE98'] },
        { slug: 'lifeguard',      label_en: 'Lifeguard',      theme: 'responder', svg: LIFEGUARD,      gradient: ['#09D1C7', '#46DFB1'] },
        { slug: 'rescue_pilot',   label_en: 'Rescue Pilot',   theme: 'responder', svg: RESCUE_PILOT,   gradient: ['#213A58', '#09D1C7'] },
    ];

    // Default character — first comic archetype.
    const DEFAULT_SLUG = 'caped_guardian';

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

    window.crispCharacterPack = {
        DEFAULT_SLUG,
        list: listCharacters,
        meta: getCharacterMeta,
        loadAsImage: loadCharacterAsImage,
        previewHtml: getCharacterPreviewHtml,
    };
})();
