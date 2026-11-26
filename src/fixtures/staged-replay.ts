/**
 * Cross-engine proof for a staged (format-2) replay with a vehicle ascent:
 * the ascent model (its deterministic exponential and logarithm, built from
 * basic arithmetic in src/mission/exact-math.ts and src/physics/dmath.ts)
 * followed by a flight with stages. A Falcon 9 (catalogue stages, written out)
 * under a 6.5 t probe launches from Kourou into a 180 km parking orbit in the
 * Moon's plane; the upper stage flies the trans-lunar injection, separates,
 * and the probe makes a small correction a day later, two days in all
 * (lunar-free-return's reference launch from Kourou, cut short). Replayed with
 * the app's sandbox options.
 *
 * src/app/staged-replay.test.ts pins the digest and the ascent's results on V8
 * (Node). check.html flies it in a worker in each browser engine (no WebGL),
 * and e2e/determinism.e2e.ts requires the same values there.
 *
 * When PHYSICS_MODEL, the data or the ascent model changes, regenerate the
 * values (and say why).
 */
export const MODEL = 2;
/** Plan without its data fingerprint (the page and the test fill in their world's). */
export const PLAN = {
  epoch: 852884584.4447339,
  duration: 2 * 86400,
  rtol: 1e-10,
  start: { kind: 'launch' as const, site: 'kourou', params: [852884584.4447339, 62.76530149471511, 180000, 540, 13.5, 0], ascent: 'vehicle' as const },
  lowerStages: [
    { wetMass: 410900, dryMass: 24100, engines: [{ thrust: 8226000, isp: 311 }] },
    { wetMass: 107500, dryMass: 4000, engines: [{ thrust: 981000, isp: 348 }] },
  ],
  spacecraft: { wetMass: 6500, dryMass: 3250, engines: [{ thrust: 10000, isp: 320 }] },
  burns: [
    { start: 3023.073865532875, duration: 59.443097464693615, stage: 1, engine: 0, direction: [1, -0.023557305589534283, 0] as [number, number, number], frame: { kind: 'orbital' as const, body: 'earth' } },
    { start: 90000, duration: 20, stage: 2, engine: 0, direction: [0, 0, 1] as [number, number, number], frame: { kind: 'orbital' as const, body: 'earth' } },
  ],
  separations: [{ time: 3682.5169629975685 }],
};
/** Recorded on V8 (Node, vitest): world fingerprint, replay digest, and the ascent's results as IEEE-754 hex. */
export const DATA = '76a862ea';
export const DIGEST = 'e0410b5de464b677';
export const ASCENT_HEX = { upperPropellant: '40d07951053aeccc', deltaV: '40c176bac81447b9', totalDeltaV: '40c7e8f53264ac73' };
