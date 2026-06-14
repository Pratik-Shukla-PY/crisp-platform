# CRISP Badge Studio - Illustrator Brief

**Status:** Open · **Owner:** Product · **Last updated:** May 2026 · **Deadline:** Submission window - illustrator-finalised art should land by June 10, 2026 so it has 13 days of QA before the UNDP deadline (June 23).

## Purpose

The CRISP Badge Studio is the reward surface that lets a citizen-reporter compose a shareable badge after they've submitted reports and earned a tier. The current art is **Canvas-painted SVG placeholders authored by the engineering team** - humanitarian-themed first-responder silhouettes, drawn with vector primitives in `mobile-app/src/character-pack.js`.

This brief commissions an **external illustrator** to deliver replacement artwork that hits the "humanitarian premium" bar the operator-supplied design plan called for. The placeholders are functional but read as engineer-drawn, not designer-drawn. UNDP judges open the PWA → tap "Share my badge" → see the canvas composition. The badge IS the first-impression deliverable for the gamification story.

## Deliverable

**4 character silhouettes**, one per V4 reward tier, delivered as:

| File | Format | Notes |
|---|---|---|
| `field-medic.svg` | Inline SVG, `viewBox="0 0 240 240"` | T1 - Scout |
| `search-rescue.svg` | same | T2 - Signal |
| `rescue-swimmer.svg` | same | T3 - Changemaker |
| `rescue-pilot.svg` | same | T4 - Lifekeeper |

All four files concatenated **must stay under 28 KB total** (the SW precache budget for the character pack is 50 KB - the current 4 placeholders total ~18 KB; we have headroom for richer detail but not a 10× increase).

## Format requirements (HARD)

These are non-negotiable because the runtime composes the SVG into a `<canvas>` via `new Image() + drawImage()`:

1. **viewBox: `0 0 240 240`.** Square. The figure is centered + the canvas circle-clip lands on shoulders/torso so each character reads as a profile-photo-sized portrait.
2. **Single-colour palette via `currentColor`.** The badge studio applies the tier gradient at paint time (`mobile-app/src/badge-studio.js::_drawCharacterAvatar`). Use `stroke="currentColor"` + `fill="currentColor"` everywhere; opacity-tinted fills via `fill-opacity="0.NN"` are encouraged for depth.
3. **Stroke width: 2-3 px.** The current placeholders use `_STROKE = 2.5`. Finer than that becomes invisible at the 72-px picker-thumbnail render size; thicker than 3 px reads as cartoon.
4. **No external font references.** Text-as-shapes or no text at all. Browser SVG font-loading is unpredictable at canvas paint time.
5. **No `<image>` raster elements.** Pure vector primitives only (`<path>`, `<circle>`, `<rect>`, `<ellipse>`).
6. **No filters / no `<defs>` with gradients.** The badge studio is responsible for the tier gradient via canvas paint; an in-SVG gradient would conflict.
7. **`stroke-linecap="round"` + `stroke-linejoin="round"` on every stroked path** (matches the placeholder file).

The wrapper element template the engineering side will swap into:

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"
     fill="none" stroke="currentColor" stroke-width="2.5"
     stroke-linecap="round" stroke-linejoin="round"
     width="100%" height="100%" aria-hidden="true">
  <!-- illustrator's path / shape elements here -->
</svg>
```

## Cultural + brand requirements

UNDP submission lens - these aren't suggestions:

- **International humanitarian reads.** Characters must look like field workers anywhere in the world, not US/UK/EU-coded.
- **No national insignia.** No flags, no national-service badges (US fire-axe, UK police helmet shape), no army-coded gear. The current Search-Rescue placeholder dropped the axe iconography for this reason.
- **Culturally neutral attire.** Field Medic's head wrap is a good model - a neutral fabric drape that reads across regions. Avoid: cowboy hats, US-style aviator caps, baseball caps with raised brims.
- **No real-person likenesses.** No celebrity references, no recognisable cartoons, no military officer caricatures.
- **No weapons.** Rescue equipment only (medical cross, harness, lifeguard whistle, rotor blades). No firearms, no batons, no axes.
- **Gender-neutral framing.** Use generic body silhouettes that don't lean masculine OR feminine. The pose communicates the role; the body shape doesn't.
- **Skin / hair: invisible.** Because everything paints in `currentColor`, the silhouettes don't carry skin or hair colour. The figure is read from posture + uniform shapes. Good.
- **Visible face.** Phase 2.4 moved Rescue Pilot's visor to "flipped UP" so the face is visible. Continue this - face-visible reads as "real person doing the work" rather than "anonymous gear suit."

## Character roles (semantic anchors)

Each character is the canonical visual for a V4 reward tier. The reporter's tier dictates which character they have access to in the picker. The art needs to make the progression FEEL like progression - T1 is the entry-level field worker, T4 is the elite specialist.

### 1. Field Medic - T1_SCOUT (entry tier)

**Reads as:** Ground-team relief-aid worker, the everyday humanitarian.

**Must-have visual cues:**

- Head wrap (international-neutral fabric drape over crown + behind neck).
- Soft-edged oval head (avoid hard circular geometry - reads as human, not robot).
- Field-vest with at least two visible cargo pockets at chest/lower-abdomen.
- Medical cross emblem on chest, modest size (≤ 18% of figure height). NOT a Red Cross logo - a generic medical cross (5-segment plus shape).
- Hands not visible (out of frame below the canvas circle clip).

**Avoid:** Lab-coat aesthetics, military medic visual (helmet + camo), surgical mask (reads as pandemic-specific, narrows the metaphor).

### 2. Search & Rescue - T2_SIGNAL

**Reads as:** Earthquake / collapse / urban-rescue field crew. The reporter has logged at least one report; the platform now recognises them.

**Must-have visual cues:**

- Utility helmet - dome shape, visible brim, **chin strap visible from helmet down to jaw** (signals "active work mode", not parade dress).
- Body harness at chest with a single carabiner clip - modest detail (≤ 12 px circle at viewBox scale).
- Gloved hands at hip level - small detail visible just inside the canvas clip.
- Reflective bands on the work jacket - two horizontal stroked lines.
- Small front-of-helmet badge (rectangle, ~16×16 px). **No insignia text** - it's a tag, not a logo.

**Avoid:** Fire-axe (national-services coded), full balaclava (reads as paramilitary), high-vis jacket as flat-fill (the badge studio's tier gradient handles the colour).

### 3. Rescue Swimmer - T3_CHANGEMAKER

**Reads as:** Water-rescue specialist. The reporter's report led to actual dispatch - they're part of the response loop now.

**Must-have visual cues:**

- Fitted wet-vest with a visible centre seam.
- Goggles **pushed up onto the forehead** (not worn over eyes; signals "ready, not in-water").
- Lanyard + whistle at chest (whistle as a small rounded rect, ≤ 12 px at viewBox scale).
- Hairline arc - a single curved line suggesting hair pulled back / wet hair (cultural-neutral).
- Two horizontal vest panel lines for depth.

**Avoid:** American-beach visor cap, surfboard, fish/dolphin iconography (reads as recreational, not rescue).

### 4. Rescue Pilot - T4_LIFEKEEPER (top tier)

**Reads as:** Helicopter rescue pilot. The most elite tier - the reporter's contribution led to lives saved.

**Must-have visual cues:**

- Helmet with visor **FLIPPED UP** so the wearer's face is visible (humanizing - see brand requirements).
- Soft dashed rotor lines at the top of the viewBox (three roughly-parallel dashed strokes; signals "helicopter context" without painting a chopper).
- Flight suit with a visible centre seam.
- Utility belt at waist with two small pouch rectangles (~20×14 px each).
- Slim boom mic curving from the helmet edge down to mouth level, ending in a small mic dot.
- A subtle chest patch (~20×20 px) - generic, no text, no flag.

**Avoid:** Aviator sunglasses, pilot wings insignia (US-coded), Top-Gun-coded leather jacket aesthetics. The character is a rescue pilot, not a fighter pilot.

## Reference: current placeholder file

Live source: `mobile-app/src/character-pack.js`. Each character is a JS string literal containing the SVG inner content (the wrapper `<svg>` element is added by the `svg()` helper at the top of the file). The illustrator should deliver standalone `.svg` files; engineering will inline them into the same module via the same `svg()` wrapper.

The current placeholders WERE intentionally engineer-drawn - they establish the silhouette grammar (centred figure, 240×240, 2.5-px stroke, `currentColor` everywhere). The illustrator's deliverable should be a **refined replacement**, not a complete rethink. Same proportions, same head-wrap concept on Field Medic, same visor-up Rescue Pilot - but with the linework quality + secondary-detail density that a real illustrator brings.

## Engineering integration

Once the 4 SVGs land:

1. Engineering replaces the JS string literals in `mobile-app/src/character-pack.js` with the illustrator's inner-SVG content.
2. The `svg()` helper preserves the wrapper attributes; the illustrator only needs to produce the inner shapes.
3. SW cache bumped (`mobile-app/src/sw.js`, `CACHE_NAME`) so returning users evict the placeholder build.
4. e2e/tests/pwa/65-badge-studio.spec.ts already covers the picker + render paths; the SVG swap is a content change with zero behaviour change.

## Out of scope

- The badge-studio canvas itself (background gradient, tier-pill, glassmorphism layer) - that's Canvas paint, not illustration.
- Tier emoji + label text - sourced from `shared/tier-config.json` (canonical) and the i18n bundle.
- The home-screen reward chip + Rewards-page tier ladder - separate surfaces, no character art.
- Animation - Phase 2.5 added a counter roll-up on the studio header. No animated SVGs needed.

## Acceptance criteria

- [ ] 4 SVG files delivered with viewBox `0 0 240 240`.
- [ ] Total bundled size ≤ 28 KB.
- [ ] Every stroke uses `currentColor`, every fill uses `currentColor` (with `fill-opacity` for depth).
- [ ] No external font, no raster, no filter, no `<defs>` gradient.
- [ ] Each character matches its tier role in the brief above.
- [ ] All four pass a side-by-side review on the live badge-studio preview at three render sizes: 72-px picker thumbnail / 280-px main preview / 1080-px export.
- [ ] Engineering smoke test passes: `node -c mobile-app/src/character-pack.js` clean + `npx playwright test 65 --project=pwa` 8/8 green.

## Compensation + IP

- This is work-for-hire. The illustrator transfers copyright + Apache-2.0 sublicensing rights on delivery (CRISP is Apache-2.0; the UNDP repo will go public 3 days before the deadline).
- One round of revision per character included; additional rounds bill at hourly rate (rate set in the SOW, not in this brief).

## Files to share with the illustrator

When briefing externally, attach:

1. This document.
2. `mobile-app/src/character-pack.js` (the placeholder source - pattern reference).
3. A screen-capture video of the Badge Studio at all 4 tiers showing the current state.
4. `shared/tier-config.json` (the canonical tier metadata - emoji / label per tier; useful for the illustrator to understand the semantic anchors).
5. `mobile-app/src/badge-studio.js` lines 130-340 (the canvas paint pipeline) - gives the illustrator context on how their SVG will composite into the final badge.

---

**Engineering contact:** product+illustration@crisplabs.tech · **Last revised:** 2026-05-15
