/**
 * IconTile — single source of truth for coloured glyphs on the RN capture flow.
 *
 * Mirrors the PWA's inline-SVG pattern (mobile-app/src/components/icon-pack.js)
 * by rendering the same 24x24 viewBox path data through react-native-svg.
 *
 * Usage:
 *   <IconTile name="FLOOD" color="#3b82f6" size={44} />
 *
 * - `name` is any key defined in ./iconPaths. Unknown keys fall through to
 *   the OTHER glyph (question-mark-in-circle) so rendering never crashes
 *   on a typo'd chip key.
 * - `color` drives both stroke and — where relevant — fill. Severity/
 *   category palettes match the PWA accent colours so a FLOOD chip on
 *   mobile looks identical to the PWA chip.
 * - `size` is square px; default 28 keeps the existing chip row compact.
 *
 * Implementation notes:
 *   · Stroke-only rendering (fill="none") — matches Lucide defaults and
 *     the PWA pack. The COMPLETE damage glyph is the one exception: it's
 *     a filled ring with a white X; handled via the `filled` branch.
 *   · `|` in the path string splits into multiple <Path> children, which
 *     corresponds to the multi-path SVGs in icon-pack.js (each element
 *     there becomes one <Path> here).
 */
import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { pathFor } from './iconPaths';

type Props = {
  /** Glyph lookup key — any entry in ICON_PATHS (see iconPaths.ts). */
  name: string;
  /** Stroke / fill colour applied to every sub-path. */
  color?: string;
  /** Square px size. */
  size?: number;
  /**
   * Stroke width. Default 2 matches Lucide / icon-pack.js. Bump to 2.5–3
   * for very large tiles (≥48 px) so the glyph reads on low-end displays.
   */
  strokeWidth?: number;
  /**
   * When true, the first sub-path is rendered as a solid filled region
   * (used for the COMPLETE damage glyph, where the ring is filled red and
   * the X is drawn white on top). Default false keeps every path as a
   * stroke-only outline.
   */
  filled?: boolean;
};

export default function IconTile({
  name,
  color = '#e2e8f0',
  size = 28,
  strokeWidth = 2,
  filled = false,
}: Props) {
  const raw = pathFor(name);
  const segments = raw.split('|');
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      // aria-hidden equivalent — the parent TouchableOpacity owns the a11y label.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {segments.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          // First path becomes solid fill when `filled` is requested
          // (COMPLETE damage tile). Subsequent paths stay stroke-only.
          fill={filled && i === 0 ? color : 'none'}
        />
      ))}
    </Svg>
  );
}
