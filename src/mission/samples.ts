/**
 * Sample missions, as data. Well-formed and exercised by
 * test/mission-samples.test.ts; not balanced for gameplay.
 */
import type { MissionDefinition } from './objectives';

const DAY = 86400;
const R_GEO = 42_164e3; // geostationary radius, m

/** From a low Earth orbit to geostationary orbit: near-circular, near-equatorial, held for 3 revolutions. */
export const GEO_FROM_LEO: MissionDefinition = {
  id: 'geo-from-leo',
  title: 'Geostationary',
  objectives: [
    {
      kind: 'orbit',
      body: 'earth',
      periapsis: [R_GEO - 100e3, R_GEO + 100e3],
      apoapsis: [R_GEO - 100e3, R_GEO + 100e3],
      inclination: [0, 1],
      reference: 'equator',
      revolutions: 3,
    },
    { kind: 'max-delta-v', max: 4500 },
    { kind: 'max-time', max: 6 * DAY },
  ],
  scoring: { deltaVRef: 4000, deltaVWeight: 1, timeRef: 4 * DAY, timeWeight: 0.25 },
};

/** Fly past the Moon between 100 km and 10 000 km altitude, then keep flying (no impact). */
export const LUNAR_FLYBY: MissionDefinition = {
  id: 'lunar-flyby',
  title: 'Lunar flyby',
  objectives: [
    { kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 10_000e3 },
    { kind: 'max-delta-v', max: 3500 },
    { kind: 'max-time', max: 7 * DAY },
  ],
  scoring: { deltaVRef: 3200, deltaVWeight: 1, timeRef: 4 * DAY, timeWeight: 0.5 },
  spheres: [{ body: 'moon', radius: 66_100e3 }],
};

/**
 * Lunar free return: one burn in low Earth orbit, a lunar flyby, then back to
 * Earth's atmosphere with no further burns (the delta-v budget allows only
 * the injection).
 */
export const LUNAR_FREE_RETURN: MissionDefinition = {
  id: 'lunar-free-return',
  title: 'Free return',
  objectives: [
    {
      kind: 'sequence',
      steps: [
        { kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 20_000e3 },
        { kind: 'reentry', body: 'earth', maxSpeed: 11_500 },
      ],
    },
    { kind: 'max-delta-v', max: 3300 },
    { kind: 'max-time', max: 12 * DAY },
  ],
  scoring: { deltaVRef: 3200, deltaVWeight: 1, timeRef: 7 * DAY, timeWeight: 0.5 },
};

export const SAMPLE_MISSIONS: readonly MissionDefinition[] = [GEO_FROM_LEO, LUNAR_FLYBY, LUNAR_FREE_RETURN];
