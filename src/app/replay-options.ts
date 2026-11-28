/**
 * The canonical replay options for a mission: the ONE definition used by the
 * replay worker (what is drawn) and by scoring (tests, future leaderboard), so
 * the digest two players compare is the digest of what they saw.
 *  - A mission replays with the mission layer's missionReplayOptions (as scored).
 *  - Sandbox adds a sphere of influence around every body that orbits
 *    another (Laplace radius a (m/M)^(2/5)), so SOI crossings are marked.
 */
import { deriveMeta } from './body-meta';
import { exactExp, exactLn, missionReplayOptions, type MissionDefinition, type ReplayOptions } from './mission-layer';
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
    // Exactly defined arithmetic only (no Math.hypot / Math.pow, which
    // ECMAScript leaves implementation-approximated): the radii are replay
    // inputs, so every engine (and core/) must get the same bits.
    const dx = b.state0[0] - P.state0[0];
    const dy = b.state0[1] - P.state0[1];
    const dz = b.state0[2] - P.state0[2];
    const a = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const r = a * exactExp(0.4 * exactLn(b.gm / P.gm));
    if (r > b.radius * 1.5) soi!.push({ body: b.id, radius: r });
  });
  return soi;
}

export function replayOptions(def: MissionDefinition | null): ReplayOptions {
  return def ? missionReplayOptions(def) : { spheres: sandboxSpheres() };
}
