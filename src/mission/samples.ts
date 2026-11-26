/**
 * The three original sample missions, as data. Their objectives and limits
 * are unchanged from the first version (test/mission-samples.test.ts flies
 * them on simplified worlds); they are also campaign missions (campaign.ts),
 * so they carry the complete setup for the real ephemeris: Kourou launch in
 * January 2027, the spacecraft, and par-based scoring from the solutions in
 * test/mission-campaign.test.ts.
 */
import type { CompleteMission } from './objectives';

const DAY = 86400;
/** 2027-01-10 12:00 UTC as TDB seconds from J2000 (TT - UTC = 69.184 s). */
export const JAN_2027 = (Date.UTC(2027, 0, 10, 12) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
const LUNAR_RULES = { launchOnly: true, sites: ['kourou'], window: [JAN_2027, JAN_2027 + 60 * DAY] as const };
/** Lunar injection stage: 30 t, 200 kN, Isp 450 s (T/W 0.68: near-impulsive burns). */
const TLI_STAGE = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] };
const R_GEO = 42_164e3; // geostationary radius, m

/** From a low Earth orbit to geostationary orbit: near-circular, near-equatorial, held for 3 revolutions. */
export const GEO_FROM_LEO: CompleteMission = {
  id: 'geo-from-leo',
  title: 'Geostationary',
  version: 1,
  briefing: 'Climb from a low parking orbit to geostationary orbit: 42,164 km from Earth’s centre, circular, within 1° of the equator, held for three revolutions. Burn at the equator crossing to raise apogee, then circularise and remove the launch-site inclination together at apogee, where the plane change is cheapest.',
  epoch: JAN_2027,
  start: { kind: 'launch', site: 'kourou', azimuthDeg: 90, altitudeM: 250e3 },
  rules: { launchOnly: true, sites: ['kourou'] },
  spacecraft: { wetMass: 23000, dryMass: 2500, engines: [{ thrust: 100e3, isp: 450 }] },
  maxDuration: 6 * DAY,
  atmosphereIsFailure: true,
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
  scoring: { deltaVRef: 3932, deltaVWeight: 1, timeRef: 347164, timeWeight: 1 },
};

/** Fly past the Moon between 100 km and 10 000 km altitude, then keep flying (no impact). */
export const LUNAR_FLYBY: CompleteMission = {
  id: 'lunar-flyby',
  title: 'Lunar flyby',
  version: 1,
  briefing: 'Fly past the Moon between 100 and 10,000 km altitude without hitting it. Launch when Kourou passes under the Moon’s orbital plane, so one prograde burn in the parking orbit does the job; the burn’s timing sets where you meet the Moon.',
  epoch: JAN_2027,
  start: { kind: 'launch', site: 'kourou', azimuthDeg: 90, altitudeM: 200e3 },
  rules: LUNAR_RULES,
  spacecraft: TLI_STAGE,
  maxDuration: 7 * DAY,
  atmosphereIsFailure: true,
  objectives: [
    { kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 10_000e3 },
    { kind: 'max-delta-v', max: 3500 },
    { kind: 'max-time', max: 7 * DAY },
  ],
  scoring: { deltaVRef: 3167.2, deltaVWeight: 1, timeRef: 252044, timeWeight: 1 },
  spheres: [{ body: 'moon', radius: 66_100e3 }],
};

/**
 * Lunar free return: one burn in low Earth orbit, a lunar flyby, then back to
 * Earth's atmosphere with no further burns (the delta-v budget allows only
 * the injection).
 */
export const LUNAR_FREE_RETURN: CompleteMission = {
  id: 'lunar-free-return',
  title: 'Free return',
  version: 1,
  briefing: 'One burn, no corrections: swing around the Moon and fall back into Earth’s atmosphere below 11.5 km/s, as Apollo’s free-return trajectories did. The budget covers the injection only, and a minute’s change in its timing misses the return corridor.',
  epoch: JAN_2027,
  start: { kind: 'launch', site: 'kourou', azimuthDeg: 90, altitudeM: 200e3 },
  rules: LUNAR_RULES,
  spacecraft: TLI_STAGE,
  maxDuration: 12 * DAY,
  atmosphereIsFailure: true,
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
  scoring: { deltaVRef: 3167.2, deltaVWeight: 1, timeRef: 704161, timeWeight: 1 },
};

export const SAMPLE_MISSIONS: readonly CompleteMission[] = [GEO_FROM_LEO, LUNAR_FLYBY, LUNAR_FREE_RETURN];
