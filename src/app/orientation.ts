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

const POLE_CACHE = new Map<string, Float64Array | null>();
const POLE_M = new Float64Array(9);

/**
 * North pole (unit, ICRF) used as screen "up" in a body-centred inertial frame,
 * taken at a fixed epoch (the plan epoch) so the view does not drift during
 * playback; the pole moves negligibly over a mission. The IAU north pole as
 * given (Venus, Uranus and Pluto point to the ecliptic south). False for the
 * Sun (Sun-centred views keep ecliptic north) and bodies without a rotation model.
 */
export function displayPole(body: number, epoch: number, out: Float64Array): boolean {
  const key = `${body}:${epoch}`;
  let p = POLE_CACHE.get(key);
  if (p === undefined) {
    p = null;
    if (BODIES[body]?.id !== 'sun' && Number.isFinite(bodyOrientation(body, epoch, POLE_M))) p = Float64Array.of(POLE_M[2], POLE_M[5], POLE_M[8]);
    if (POLE_CACHE.size > 256) POLE_CACHE.clear();
    POLE_CACHE.set(key, p);
  }
  if (!p) return false;
  out.set(p);
  return true;
}
