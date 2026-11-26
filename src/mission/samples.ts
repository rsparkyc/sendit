/**
 * The three original sample missions, as data. Their objectives are those of
 * the first version (test/mission-samples.test.ts flies them on simplified
 * worlds); they are also campaign missions (campaign.ts), so they carry the
 * complete setup for the real ephemeris: a launch window from January 2027,
 * every launch site (campaign-sites.ts), and par-based scoring.
 *
 * Version 4 (launch vehicles): each flies a catalogue launcher (rules.vehicle)
 * and the ascent is charged; scoring and the delta-v limits are on the total
 * delta-v (ascent + flight). geo-from-leo: a 10 t satellite on an Ariane 5
 * ECA, whose upper stage flies the transfer burn; the two lunar missions: a
 * 6.5 t probe on a Falcon 9, whose upper stage flies the injection. Each opens
 * at, and scores against, its best reference site (parSite); every offered
 * site has its own limits: ascent + flight x the mission's original ratio of
 * limit to par (geo 1.145, lunar flyby 1.105, free return 1.042, applied to
 * the flight only), and the original flat time limits (6, 7 and 12 days).
 * The reference plans live in test/fixtures/campaign-solutions.json.
 */
import { CAMPAIGN_SITES, loosestLimits, offeredSites, parSite, sitePar } from './campaign-sites';
import { vehicleLaunch, type CompleteMission } from './objectives';
import { catalogueStages, PARKING_BAND } from './vehicles';

const DAY = 86400;
/** 2027-01-10 12:00 UTC as TDB seconds from J2000 (TT - UTC = 69.184 s). */
export const JAN_2027 = (Date.UTC(2027, 0, 10, 12) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
const LUNAR_RULES = { launchOnly: true, window: [JAN_2027, JAN_2027 + 60 * DAY] as const, vehicle: vehicleLaunch(catalogueStages('falcon-9'), PARKING_BAND) };
/** Lunar probe on a Falcon 9: 6.5 t, 10 kN, Isp 320 s. The upper stage flies the injection. */
const LUNAR_PROBE = { wetMass: 6500, dryMass: 3250, engines: [{ thrust: 10e3, isp: 320 }] };
const R_GEO = 42_164e3; // geostationary radius, m

/** From a low Earth orbit to geostationary orbit: near-circular, near-equatorial, held for 3 revolutions. */
export const GEO_FROM_LEO: CompleteMission = {
  id: 'geo-from-leo',
  title: 'Geostationary',
  version: 4,
  briefing: 'Climb from a low parking orbit to geostationary orbit: {geo}, circular, within 1° of the equator, held for three revolutions, on an Ariane 5. Its hydrogen upper stage burns at the equator crossing to raise apogee; separate it there, and your satellite circularises and removes the launch-site inclination together at apogee, where the plane change is cheapest. A site near the equator pays twice: more of Earth’s rotation in the ascent, less plane to remove.',
  briefingDistances: { geo: { kind: 'radius', body: 'earth', value: R_GEO } },
  epoch: JAN_2027,
  start: { kind: 'launch', site: parSite('geo-from-leo'), azimuthDeg: 90, altitudeM: 200e3 },
  rules: { launchOnly: true, sites: offeredSites('geo-from-leo'), vehicle: vehicleLaunch(catalogueStages('ariane-5-eca'), PARKING_BAND) },
  spacecraft: { wetMass: 10000, dryMass: 4500, engines: [{ thrust: 10e3, isp: 320 }] },
  maxDuration: 6 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['geo-from-leo'],
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
    { kind: 'max-delta-v', max: loosestLimits('geo-from-leo').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('geo-from-leo').maxTime },
  ],
  scoring: sitePar('geo-from-leo', parSite('geo-from-leo')),
};

/** Fly past the Moon between 100 km and 10 000 km altitude, then keep flying (no impact). */
export const LUNAR_FLYBY: CompleteMission = {
  id: 'lunar-flyby',
  title: 'Lunar flyby',
  version: 4,
  briefing: 'Fly past the Moon at {pass} without hitting it, on a Falcon 9. Launch when your site passes under the Moon’s orbital plane (from a site too far from the equator to reach that plane, into a plane through where the Moon will be), so one prograde burn of the upper stage in the parking orbit does the job; the burn’s timing sets where you meet the Moon. Launch steeply or high and the upper stage runs short: your probe has to finish the burn.',
  briefingDistances: { pass: { kind: 'altitude-band', body: 'moon', lo: 100e3, hi: 10_000e3 } },
  epoch: JAN_2027,
  start: { kind: 'launch', site: parSite('lunar-flyby'), azimuthDeg: 90, altitudeM: 200e3 },
  rules: { ...LUNAR_RULES, sites: offeredSites('lunar-flyby') },
  spacecraft: LUNAR_PROBE,
  maxDuration: 7 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['lunar-flyby'],
  objectives: [
    { kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 10_000e3 },
    { kind: 'max-delta-v', max: loosestLimits('lunar-flyby').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('lunar-flyby').maxTime },
  ],
  scoring: sitePar('lunar-flyby', parSite('lunar-flyby')),
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
  version: 4,
  briefing: 'One injection, no corrections: swing around the Moon and fall back into Earth’s atmosphere below 11.5 km/s, as Apollo’s free-return trajectories did. The budget covers the ascent and the injection only, and a minute’s change in its timing misses the return corridor.',
  epoch: JAN_2027,
  start: { kind: 'launch', site: parSite('lunar-free-return'), azimuthDeg: 90, altitudeM: 200e3 },
  rules: { ...LUNAR_RULES, sites: offeredSites('lunar-free-return') },
  spacecraft: LUNAR_PROBE,
  maxDuration: 12 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['lunar-free-return'],
  objectives: [
    {
      kind: 'sequence',
      steps: [
        { kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 20_000e3 },
        { kind: 'reentry', body: 'earth', maxSpeed: 11_500 },
      ],
    },
    { kind: 'max-delta-v', max: loosestLimits('lunar-free-return').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('lunar-free-return').maxTime },
  ],
  scoring: sitePar('lunar-free-return', parSite('lunar-free-return')),
};

export const SAMPLE_MISSIONS: readonly CompleteMission[] = [GEO_FROM_LEO, LUNAR_FLYBY, LUNAR_FREE_RETURN];
