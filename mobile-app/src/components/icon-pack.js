/**
 * CRISP icon pack — shared SVG sprites.
 *
 * Single source of truth for every chip icon on the capture flow, so
 * both the PWA (inline SVG) and RN (react-native-svg) render the same
 * shapes. Sourced from Lucide (MIT) — https://lucide.dev/ — trimmed to
 * just the CRISP-needed glyphs + constant-width stroke styling.
 *
 * Why SVG over FontAwesome: (a) UNDP wants colour-coded icons per
 * category; FontAwesome glyphs pick up `color:` inheritance but share
 * the same grey default and look washed out next to brand accents.
 * (b) SVGs render identically on Edge, Windows, and the RN Android
 * raster; emoji-flag parity tests showed FontAwesome does the same
 * fallback-failure on browsers without its webfont.
 *
 * Each export returns a raw <svg ...> string so callers can `.innerHTML`
 * it directly OR pass it to a <path d> extractor for RN. The size /
 * colour / stroke-width come from CSS (currentColor + width:100%) so
 * one pack drives every tile size on both platforms.
 *
 * Naming matches the PWA's `data-crisis` / `data-type` attributes so a
 * simple `ICON_PACK[key]` lookup works.
 */

const _STROKE = 2;

/** Tiny helper — every glyph shares the same outer shell + viewport. */
function svg(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
         `stroke="currentColor" stroke-width="${_STROKE}" stroke-linecap="round" ` +
         `stroke-linejoin="round" width="100%" height="100%" aria-hidden="true">${inner}</svg>`;
}

// ── Infrastructure (UNDP super-types + CRISP chips) ─────────────────────────

const _HOUSE        = svg(`<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`);
const _HOSPITAL     = svg(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/>`);
const _SCHOOL       = svg(`<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>`);
const _ROAD         = svg(`<path d="M4 19h16M6 5h2l-2 14M16 5h2l2 14M11 5v4M11 13v4"/>`);
const _POWER        = svg(`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`);
const _WATER        = svg(`<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>`);
const _TELECOM      = svg(`<path d="M4.93 19.07A10 10 0 0 1 4.93 4.93M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M16.24 7.76a6 6 0 0 1 0 8.48"/><circle cx="12" cy="12" r="2"/>`);
const _GOVERNMENT   = svg(`<path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/>`);
const _OTHER        = svg(`<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>`);

// ── Crisis types ────────────────────────────────────────────────────────────

const _EARTHQUAKE   = svg(`<path d="M3 12l3-3 3 6 3-9 3 6 3-3 3 3"/>`);
const _FLOOD        = svg(`<path d="M2 12c2 2 4 2 6 0s4-2 6 0 4 2 6 0M2 18c2 2 4 2 6 0s4-2 6 0 4 2 6 0M2 6c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/>`);
const _TSUNAMI      = svg(`<path d="M2 14c3-4 6-4 9-1s6 3 11-2M2 20c3-4 6-4 9-1s6 3 11-2"/>`);
const _CYCLONE      = svg(`<path d="M21 4a10 10 0 0 0-18 4c2 4 8 6 13 3M14 11a3 3 0 1 0-3 5"/>`);
const _LANDSLIDE    = svg(`<path d="M2 20l6-10 4 6 4-4 6 8z"/>`);
const _EXPLOSION    = svg(`<path d="M14 4l-2 4 2 2-4 2 2 4-4-2-2 4-2-4-4 2 2-4-4-2 4-2-2-4 4 2 2-4 2 4 4-2z"/>`);
const _CHEMICAL     = svg(`<path d="M10 2v7.5l-5 8.5a3 3 0 0 0 2.6 4.5h8.8a3 3 0 0 0 2.6-4.5l-5-8.5V2M8 2h8M7 14h10"/>`);
const _PANDEMIC     = svg(`<circle cx="12" cy="12" r="8"/><path d="M12 4v-2M12 22v-2M4 12h-2M22 12h-2M6.3 6.3l-1.4-1.4M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>`);
const _CONFLICT     = svg(`<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5"/>`);
const _CIVIL_UNREST = svg(`<circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M14 21v-2a4 4 0 0 1 3-3.87"/>`);

// ── Damage severity dots — hollow vs filled, palette-ready ──────────────────

const _DAMAGE_MINIMAL  = svg(`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>`);
const _DAMAGE_PARTIAL  = svg(`<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14" stroke-width="2.5"/>`);
const _DAMAGE_COMPLETE = svg(`<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M8 8l8 8M16 8l-8 8" stroke="white" stroke-width="2.5"/>`);

// ── Service status & misc ────────────────────────────────────────────────────

const _CHECK         = svg(`<polyline points="20 6 9 17 4 12"/>`);
const _ALERT         = svg(`<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`);
const _LOCATION      = svg(`<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>`);
const _BUILDING      = svg(`<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M8 10h.01M8 14h.01M16 6h.01M16 10h.01M16 14h.01"/>`);
const _CAMERA        = svg(`<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>`);
const _MIC           = svg(`<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"/>`);
const _ARROW_RIGHT   = svg(`<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`);
const _ARROW_LEFT    = svg(`<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`);
const _REFRESH       = svg(`<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`);
const _SEND          = svg(`<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>`);
const _BOLT          = svg(`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`);   // reused for UTILITY super-type
const _HEALTH        = svg(`<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>`);

export const ICON_PACK = Object.freeze({
  // Infra super-types / legacy chips — same lookup keys the app.js uses.
  HOUSE:      _HOUSE,
  RESIDENTIAL: _HOUSE,
  HOSPITAL:   _HOSPITAL,
  SCHOOL:     _SCHOOL,
  COMMUNITY:  _HOSPITAL,   // community-building super-type tile uses hospital glyph
  ROAD:       _ROAD,
  TRANSPORT_COMMUNICATION: _ROAD,
  POWER:      _POWER,
  UTILITY:    _BOLT,
  WATER:      _WATER,
  TELECOM:    _TELECOM,
  GOVERNMENT: _GOVERNMENT,
  COMMERCIAL: _BUILDING,
  PUBLIC_SPACES: _BUILDING,
  OTHER:      _OTHER,

  // Crisis types.
  EARTHQUAKE: _EARTHQUAKE,
  FLOOD:      _FLOOD,
  TSUNAMI:    _TSUNAMI,
  CYCLONE:    _CYCLONE,
  HURRICANE:  _CYCLONE,   // legacy alias → same glyph
  LANDSLIDE:  _LANDSLIDE,
  EXPLOSION:  _EXPLOSION,
  CHEMICAL_INCIDENT: _CHEMICAL,
  PANDEMIC:   _PANDEMIC,
  CONFLICT:   _CONFLICT,
  CIVIL_UNREST: _CIVIL_UNREST,

  // Damage levels — used in severity dots (visual only).
  MINIMAL:   _DAMAGE_MINIMAL,
  PARTIAL:   _DAMAGE_PARTIAL,
  COMPLETE:  _DAMAGE_COMPLETE,

  // Misc controls.
  CHECK: _CHECK, ALERT: _ALERT, LOCATION: _LOCATION, BUILDING: _BUILDING,
  CAMERA: _CAMERA, MIC: _MIC, HEALTH: _HEALTH,
  ARROW_RIGHT: _ARROW_RIGHT, ARROW_LEFT: _ARROW_LEFT,
  REFRESH: _REFRESH, SEND: _SEND,
});

/**
 * Lookup helper — always returns a valid SVG string (falls through to
 * OTHER glyph on unknown keys, never undefined). Exposed on `window`
 * so inline HTML data-attributes can resolve to an icon without a
 * module import.
 */
export function iconFor(key) {
  return ICON_PACK[key] || ICON_PACK.OTHER;
}

// Browser-side convenience — a single entry point for inline `onload`
// handlers + the stage-split renderer in app.js.
if (typeof window !== 'undefined') {
  window.CrispIconPack = ICON_PACK;
  window.crispIconFor = iconFor;
}
