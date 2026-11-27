/**
 * The map's colour and shape system, in one place (scene.ts, main.ts markers,
 * timeline.ts, the panels' stage chips and the legend all read it). Dark
 * background; every kind differs by shape or text as well as colour, so a
 * colour-blind player (or a grey-scale screenshot) can still tell them apart.
 *
 *  Trajectory   coast ahead of the cursor: near-white thin line; behind the
 *               cursor: grey; far revolutions: faint white. (White is used by
 *               nothing else drawn on the map, so it never reads as a body's
 *               path or a launch site.)
 *  Burns        thick line (4.5 px, three times the coast) in the colour of the
 *               stage that flies it; its node, ignition and cutoff markers carry
 *               the stage tag in text ("B1 · S2"); timeline spans are striped in
 *               the stage colour with the tag written on them.
 *  Stages       S1 magenta, S2 cyan, S3 pink, S4 lavender; the spacecraft (SC)
 *               orange. Lightness differs as well as hue (orange and cyan read
 *               light, magenta and pink mid) and the tag is always written.
 *  Bodies       their orbit paths in each body's own colour, thin and at 45 %
 *               opacity: always fainter and thinner than the trajectory.
 *  Markers      events: blue diamonds, plain text; closest approach: amber
 *               diamond; failure: red, bold; maneuver nodes: round dot in the
 *               stage colour, boxed bold text; burn ignition ▶ / cutoff ■;
 *               separations: teal ✂ with "S1 → S2"; plane AN / DN: violet
 *               triangles up / down.
 *  Launch sites green squares (the selected one larger, ringed, white text on
 *               green): the only green on the map.
 *  Overlays     equator disc pale blue, target plane amber, spin axis red (N)
 *               and blue (S) with N / S labels.
 *  Selection    a white ring (dots) or a white outline (timeline spans).
 */

import { el } from './dom';

/** Per-stage colours, by stage index from the bottom (S1 = 0). The spacecraft has its own. */
const STAGE_COLOURS = ['#e05cff', '#4fd6ff', '#ff6fa3', '#c3b4ff'];
export const SPACECRAFT_COLOUR = '#ff8a3d';

export const MAP = {
  coast: 0xf4f7fb,
  coastPast: 0x6f7a8a,
  coastFar: 0xf4f7fb,
  site: '#7dffb0',
  event: '#9fc6ff',
  closest: '#ffd36b',
  failure: '#ff4d4d',
  separation: '#3fd0c0',
  planeNode: '#c9a2ff',
} as const;

export interface StageStyle {
  /** CSS colour. */
  colour: string;
  /** The same as a number (three.js). */
  hex: number;
  /** "S1", "S2" or "SC". */
  tag: string;
}

/** Visual identity of a stage: `index` from the bottom, `isSpacecraft` for the top. */
export function stageStyle(index: number, isSpacecraft: boolean, tag?: string): StageStyle {
  const colour = isSpacecraft ? SPACECRAFT_COLOUR : STAGE_COLOURS[Math.max(0, index) % STAGE_COLOURS.length];
  return { colour, hex: parseInt(colour.slice(1), 16), tag: tag ?? (isSpacecraft ? 'SC' : `S${index + 1}`) };
}

/** A stage tag chip in the stage's colour (palette.ts); the tag is the text cue, the colour the second one. */
export function stageChip(index: number, isSpacecraft: boolean, tag: string, title = ''): HTMLElement {
  const c = el('span', { className: `nstage${isSpacecraft ? ' sc' : ''}`, textContent: tag, title });
  c.style.setProperty('--stage', stageStyle(index, isSpacecraft, tag).colour);
  return c;
}

