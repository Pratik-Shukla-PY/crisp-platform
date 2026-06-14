/**
 * CRISP icon path dictionary - RN counterpart of the PWA's
 * `mobile-app/src/components/icon-pack.js`. Same keys, same 24x24 viewBox;
 * values are raw `d=…` path strings (+ `|` delimiter for multi-path glyphs)
 * so react-native-svg can render them via <Path d={...}/> without any
 * string-HTML parsing.
 *
 * Encoding choice: each entry is either a single `d` attribute OR multiple
 * `d` attributes joined with `|`. IconTile.tsx splits on `|` and emits one
 * <Path> per segment. A handful of glyphs in icon-pack.js use <polyline>,
 * <polygon>, <rect>, <circle>, or <line> - we lossily convert those to the
 * equivalent `d` path syntax below so everything can go through <Path>:
 *
 *   polyline points="20 6 9 17 4 12"     →  M20 6 L9 17 L4 12
 *   polygon points="13 2 3 14 12 14 …"   →  M13 2 L3 14 L12 14 … Z
 *   rect x=.. y=.. w=.. h=..              →  M{x},{y} h{w} v{h} h-{w} Z
 *   circle cx cy r                        →  M{cx-r},{cy} a{r},{r} 0 1 0 {2r},0 a{r},{r} 0 1 0 -{2r},0
 *   line x1 y1 x2 y2                      →  M{x1} {y1} L{x2} {y2}
 *
 * The visual result is identical because all glyphs are stroked (fill="none"
 * except where noted) and react-native-svg's stroke-linecap/linejoin match
 * Lucide's defaults.
 *
 * Keep the key list in lock-step with icon-pack.js. See that file for the
 * design rationale (Lucide MIT + color-coded per-category).
 */

// Helper literals - keeps path definitions readable.
// Full-circle stroked ring (cx=12, cy=12, r=10).
const RING = 'M2,12 a10,10 0 1 0 20,0 a10,10 0 1 0 -20,0';
// Filled dot at (12,12,r=3).
const DOT_SMALL = 'M9,12 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0';
// Filled dot at (12,10,r=3).
const DOT_LOCATION = 'M9,10 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0';
// Filled dot at (12,13,r=4).
const DOT_CAMERA = 'M8,13 a4,4 0 1 0 8,0 a4,4 0 1 0 -8,0';
// Filled dot at (12,12,r=2).
const DOT_TELECOM = 'M10,12 a2,2 0 1 0 4,0 a2,2 0 1 0 -4,0';
// Circle at (9,7,r=3) and (17,7,r=3) for CIVIL_UNREST.
const DOT_CIVIL_A = 'M6,7 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0';
const DOT_CIVIL_B = 'M14,7 a3,3 0 1 0 6,0 a3,3 0 1 0 -6,0';
// Ring (8) for pandemic.
const RING_PAN = 'M4,12 a8,8 0 1 0 16,0 a8,8 0 1 0 -16,0';

export const ICON_PATHS: Record<string, string> = {
  // Infrastructure super-types + legacy chips (same values share a glyph).
  HOUSE: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22 L9 12 L15 12 L15 22',
  RESIDENTIAL: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M9 22 L9 12 L15 12 L15 22',
  HOSPITAL: 'M5,3 h14 a2,2 0 0 1 2,2 v14 a2,2 0 0 1 -2,2 h-14 a2,2 0 0 1 -2,-2 v-14 a2,2 0 0 1 2,-2 Z|M12 8v8M8 12h8',
  SCHOOL: 'M22 10v6M2 10l10-5 10 5-10 5z|M6 12v5c3 3 9 3 12 0v-5',
  // Community tile shares the hospital glyph per PWA icon-pack.js.
  COMMUNITY: 'M5,3 h14 a2,2 0 0 1 2,2 v14 a2,2 0 0 1 -2,2 h-14 a2,2 0 0 1 -2,-2 v-14 a2,2 0 0 1 2,-2 Z|M12 8v8M8 12h8',
  ROAD: 'M4 19h16M6 5h2l-2 14M16 5h2l2 14M11 5v4M11 13v4',
  TRANSPORT_COMMUNICATION: 'M4 19h16M6 5h2l-2 14M16 5h2l2 14M11 5v4M11 13v4',
  POWER: 'M13 2 L3 14 L12 14 L11 22 L21 10 L12 10 L13 2 Z',
  // Utility super-type reuses the bolt glyph.
  UTILITY: 'M13 2 L3 14 L12 14 L11 22 L21 10 L12 10 L13 2 Z',
  BOLT: 'M13 2 L3 14 L12 14 L11 22 L21 10 L12 10 L13 2 Z',
  WATER: 'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z',
  TELECOM: `M4.93 19.07A10 10 0 0 1 4.93 4.93M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M16.24 7.76a6 6 0 0 1 0 8.48|${DOT_TELECOM}`,
  GOVERNMENT: 'M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3',
  COMMERCIAL: 'M6,2 h12 a2,2 0 0 1 2,2 v18 a2,2 0 0 1 -2,2 h-12 a-2,2 0 0 1 -2,-2 v-18 a-2,2 0 0 1 2,-2 Z|M9 22v-4h6v4M8 6h.01M8 10h.01M8 14h.01M16 6h.01M16 10h.01M16 14h.01',
  PUBLIC_SPACES: 'M6,2 h12 a2,2 0 0 1 2,2 v18 a2,2 0 0 1 -2,2 h-12 a-2,2 0 0 1 -2,-2 v-18 a-2,2 0 0 1 2,-2 Z|M9 22v-4h6v4M8 6h.01M8 10h.01M8 14h.01M16 6h.01M16 10h.01M16 14h.01',
  OTHER: `${RING}|M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3|M12 17 L12.01 17`,

  // Crisis types.
  EARTHQUAKE: 'M3 12l3-3 3 6 3-9 3 6 3-3 3 3',
  FLOOD: 'M2 12c2 2 4 2 6 0s4-2 6 0 4 2 6 0M2 18c2 2 4 2 6 0s4-2 6 0 4 2 6 0M2 6c2 2 4 2 6 0s4-2 6 0 4 2 6 0',
  TSUNAMI: 'M2 14c3-4 6-4 9-1s6 3 11-2M2 20c3-4 6-4 9-1s6 3 11-2',
  CYCLONE: 'M21 4a10 10 0 0 0-18 4c2 4 8 6 13 3M14 11a3 3 0 1 0-3 5',
  HURRICANE: 'M21 4a10 10 0 0 0-18 4c2 4 8 6 13 3M14 11a3 3 0 1 0-3 5',
  LANDSLIDE: 'M2 20l6-10 4 6 4-4 6 8z',
  EXPLOSION: 'M14 4l-2 4 2 2-4 2 2 4-4-2-2 4-2-4-4 2 2-4-4-2 4-2-2-4 4 2 2-4 2 4 4-2z',
  CHEMICAL_INCIDENT: 'M10 2v7.5l-5 8.5a3 3 0 0 0 2.6 4.5h8.8a3 3 0 0 0 2.6-4.5l-5-8.5V2M8 2h8M7 14h10',
  PANDEMIC: `${RING_PAN}|M12 4v-2M12 22v-2M4 12h-2M22 12h-2M6.3 6.3l-1.4-1.4M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4`,
  CONFLICT: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5L18 3h3v3l-3.5 3.5',
  CIVIL_UNREST: `${DOT_CIVIL_A}|${DOT_CIVIL_B}|M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M14 21v-2a4 4 0 0 1 3-3.87`,

  // Damage levels. Colour/fill driven by the caller through <Path fill=...>.
  MINIMAL: `${RING}|${DOT_SMALL}`,
  PARTIAL: `${RING}|M4.93 4.93 L19.07 19.07`,
  // Destroyed: filled disc with white X. IconTile renders a solid ring + X.
  COMPLETE: `${RING}|M8 8 L16 16|M16 8 L8 16`,

  // Misc controls.
  CHECK: 'M20 6 L9 17 L4 12',
  ALERT: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9 L12 13|M12 17 L12.01 17',
  LOCATION: `M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z|${DOT_LOCATION}`,
  BUILDING: 'M6,2 h12 a2,2 0 0 1 2,2 v18 a2,2 0 0 1 -2,2 h-12 a-2,2 0 0 1 -2,-2 v-18 a-2,2 0 0 1 2,-2 Z|M9 22v-4h6v4M8 6h.01M8 10h.01M8 14h.01M16 6h.01M16 10h.01M16 14h.01',
  CAMERA: `M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z|${DOT_CAMERA}`,
  MIC: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8',
  HEALTH: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  ARROW_RIGHT: 'M5 12 L19 12|M12 5 L19 12 L12 19',
  ARROW_LEFT: 'M19 12 L5 12|M12 19 L5 12 L12 5',
  REFRESH: 'M23 4 L23 10 L17 10|M1 20 L1 14 L7 14|M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  SEND: 'M22 2 L11 13|M22 2 L15 22 L11 13 L2 9 L22 2 Z',
};

/**
 * Deterministic lookup helper - always returns a valid entry, falling
 * through to OTHER if the key is unknown. Matches the PWA's iconFor().
 */
export function pathFor(key: string): string {
  return ICON_PATHS[key] || ICON_PATHS.OTHER;
}
