/**
 * The canonical replay options for a mission: the ONE definition used by the
 * replay worker (what is drawn) and by scoring (tests, future leaderboard), so
 * the digest two players compare is the digest of what they saw.
 *  - A mission replays with exactly its definition's spheres (as scored).
 *  - Sandbox adds a sphere of influence around every body that orbits
 *    another (Laplace radius a (m/M)^(2/5)), so SOI crossings are marked.
 */
import { deriveMeta } from './body-meta';
import type { MissionDefinition, ReplayOptions } from './mission-layer';
import { BODIES } from './physics';

let soi: { body: string; radius: number }[] | null = null;

export function sandboxSpheres(): { body: string; radius: number }[] {
  if (soi) return soi;
  const meta = deriveMeta(BODIES);
  soi = [];
  BODIES.forEach((b, i) => {
    const p = meta[i].parent;
    if (p < 0) return;
    const P = BODIES[p];
    const a = Math.hypot(b.state0[0] - P.state0[0], b.state0[1] - P.state0[1], b.state0[2] - P.state0[2]);
    const r = a * Math.pow(b.gm / P.gm, 0.4);
    if (r > b.radius * 1.5) soi!.push({ body: b.id, radius: r });
  });
  return soi;
}

export function replayOptions(def: MissionDefinition | null): ReplayOptions {
  return def ? { spheres: def.spheres } : { spheres: sandboxSpheres() };
}
