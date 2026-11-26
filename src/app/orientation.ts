/**
 * Body orientation for surface-fixed frames (frames.ts `Orientation`).
 * Earth uses the launch code's rotation model (through the mission adapter),
 * so a launch site and the flown insertion point stand still in the Earth
 * surface frame exactly as the replay put them; other bodies use the IAU
 * rotation the textures are drawn with. Display-only.
 */
import { IAU_ROTATION, bodyToIcrf } from './body-rotation';
import type { Orientation } from './frames';
import { earthOrientation } from './mission-layer';
import { BODIES } from './physics';

const DEG = Math.PI / 180;

export const bodyOrientation: Orientation = (body, t, out) => {
  const id = BODIES[body]?.id;
  if (id === 'earth') return earthOrientation(t, out);
  const m = id ? IAU_ROTATION[id] : undefined;
  if (!m) return NaN;
  bodyToIcrf(m, t, out);
  return (m.pm[1] * DEG) / 86400;
};

/** Whether a body can anchor a surface frame. */
export const hasSurfaceFrame = (body: number): boolean => {
  const id = BODIES[body]?.id;
  return id === 'earth' || (!!id && !!IAU_ROTATION[id]);
};
