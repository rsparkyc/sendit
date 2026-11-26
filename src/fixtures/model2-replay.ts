/**
 * Cross-engine proof for the CURRENT physics model on a real mission replay
 * (src/fixtures/determinism.ts covers the integrator alone on a fixed body).
 * One sandbox flight in the real ephemeris world: a Cape Canaveral launch
 * into a 250 km parking orbit, a 300 s apogee-raising burn, two days of
 * flight (Earth's degree-4 field with its time-dependent pole and Earth
 * rotation angle, the Moon's field, the Sun, events, a finite burn), replayed
 * with the app's sandbox options. test: src/app/model2-replay.test.ts pins the
 * digest on V8 (Node); e2e/determinism.e2e.ts flies the same plan in each
 * browser engine through the editor and must get the same digest.
 *
 * When PHYSICS_MODEL or the data changes, regenerate DIGEST (and say why).
 */
export const MODEL = 2;
/** Plan without its data fingerprint (the page and the test fill in their world's). */
export const PLAN = {
  epoch: 8.5e8,
  duration: 2 * 86400,
  rtol: 1e-10,
  start: { kind: 'launch' as const, site: 'cape-canaveral', params: [8.5e8, 90, 250e3, 540, 13.5, 0] },
  spacecraft: { wetMass: 20000, dryMass: 4000, engines: [{ thrust: 100e3, isp: 450 }] },
  burns: [{ start: 3000, duration: 300, engine: 0, direction: [1, 0, 0] as [number, number, number], frame: { kind: 'orbital' as const, body: 'earth' } }],
};
/** World fingerprint and replay digest recorded on V8 (Node, vitest). */
export const DATA = '76a862ea';
export const DIGEST = '4ca023ac13053da6'; // equal to the model-2 golden digest of test/mission-replay-api.test.ts (no sphere events in two days of Earth orbit)
