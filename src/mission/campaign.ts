/**
 * The campaign: twelve authored missions on the real ephemeris, in rising
 * difficulty, each teaching one idea. Complete definitions (start, rules,
 * spacecraft, limits, scoring), so the editor and a leaderboard need nothing
 * else; a leaderboard keys on `id` + `version`.
 *
 * HOW THE NUMBERS WERE SET. Every mission was solved through the plan ->
 * replay path (test/mission-campaign-solve.test.ts shows how; the plans are
 * kept as literals in test/mission-campaign.test.ts, never exposed here).
 * From each solution ("par"):
 *  - max delta-v = par x 1.08, rounded up to 10 m/s (8%: room for finite-burn
 *    losses and a player's less precise timing, not for a different method);
 *    the one-burn free return keeps its original, tighter limit by design;
 *  - max time = par x 1.25 near Earth (rounded up to 10 minutes), x 1.15 for
 *    interplanetary missions (rounded up to the day), where a different
 *    transfer type changes time a lot;
 *  - scoring refs = par delta-v and par time, weights 1:1, so a run matching
 *    the author's solution scores PAR_SCORE (10 000) on every mission.
 * The three original samples (samples.ts) keep their first-version limits
 * at their default site, which the editor's own solutions were built against.
 *
 * PHYSICS MODEL 2 (version 3; plane-change version 2). Every solution was
 * re-derived from scratch under model 2 with the solver tooling, and par,
 * per-site references and limits re-set by the rules above. Altitudes in
 * objectives are above each body's reference (equatorial) radius
 * (altitudeBand), so bands are round numbers; inclination is measured
 * against the pole the physics uses at that time. The launch is fixed per
 * mission (rules.launch: parking altitude of the reference solution, 200 km
 * for most, 250 km for geostationary, 300 km for escape, 400 km for plane
 * change; default ascent, downrange and circularisation), because the
 * abstracted launch is not charged for: the player chooses site, liftoff time
 * and azimuth.
 *
 * LAUNCH SITES (version 2). The player chooses the site: latitude decides the
 * reachable inclinations, the range-safety corridor the azimuths, longitude
 * the timing. `launchSites` (campaign-sites.ts) lists every site with its own
 * reference solution and limits (the margins above, applied to that site's
 * reference), or why it is not offered; `rules.sites` is the offered list and
 * the max-delta-v / max-time objectives carry the loosest offered limits
 * (evaluate applies the plan's own site's). Scoring keeps ONE par per mission
 * (the default site's solution) for every site, so the all-sites leaderboard
 * compares sites directly and a better site scores better. plane-change stays
 * at Cape Canaveral: its lesson is the Cape's corridor.
 *
 * SPACECRAFT. Fixed per mission (checkPlanConformance enforces it) and chosen
 * for what they teach; thrust-to-weight (T/W, in Earth g) sets how far burns
 * are from impulsive:
 *  - plane-change: small storable stage, T/W 0.42: near-impulsive burns, the
 *    lesson is geometry only.
 *  - geo / lunar flyby / free return: hydrolox stages, T/W 0.44-0.68.
 *  - earth-escape: 5 kN on 5 t, T/W 0.10: one long burn wastes hundreds of
 *    m/s, so the budget forces burns split over several perigee passes.
 *  - lunar-orbit: 60 kN on 26 t, T/W 0.24: a 17-minute injection that must be
 *    centred on the right point, and a capture burn to plan around periselene.
 *  - mars-flyby: 30 kN on 10 t, T/W 0.31: a 14-minute departure burn.
 *  - venus/mars/mercury probes: 60 kN, T/W 0.5-0.6; outer planets: a 45 t
 *    stack at 200 kN, T/W 0.45, sized for C3 ~ 80 km^2/s^2 departures.
 */
import { CAMPAIGN_SITES, loosestLimits, offeredSites } from './campaign-sites';
import { fixedLaunch, type Band, type CompleteMission } from './objectives';
import { J2000_BODIES } from '../physics/solar-system';
import { GEO_FROM_LEO, JAN_2027, LUNAR_FLYBY, LUNAR_FREE_RETURN } from './samples';

const DAY = 86400;
const HOUR = 3600;
const YEAR = 365.25 * DAY;

/** TDB seconds from J2000 for a UTC calendar time (TT - UTC = 69.184 s from 2017; TDB - TT < 2 ms ignored). */
export function utcTdb(year: number, month: number, day: number, hour = 0): number {
  return (Date.UTC(year, month - 1, day, hour) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
}

/**
 * A band of altitudes [lo, hi] (m) above a body's reference radius
 * (BodyData.referenceRadius, the radius every altitude in the game is
 * measured from), as the distances from its centre that orbit objectives use.
 */
export function altitudeBand(body: string, lo: number, hi: number): Band {
  const b = J2000_BODIES.find((x) => x.id === body);
  if (!b) throw new Error(`unknown body ${body}`);
  return [b.referenceRadius + lo, b.referenceRadius + hi];
}
const launchStart = (site: string, altitudeM = 200e3) => ({ kind: 'launch' as const, site, azimuthDeg: 90, altitudeM });
/** Launch rules: site list, launch only, and the parking orbit fixed at the reference solution's altitude. */
const launchRules = (id: string, altitudeM = 200e3) => ({ launchOnly: true, sites: offeredSites(id), launch: fixedLaunch(altitudeM) });
const par = (deltaV: number, time: number) => ({ deltaVRef: deltaV, deltaVWeight: 1, timeRef: time, timeWeight: 1 });

export const PLANE_CHANGE: CompleteMission = {
  id: 'plane-change', title: 'Plane change', version: 2,
  briefing: 'Reach a circular orbit at {orbit}, inclined 64-66° to the equator, from Cape Canaveral. Range safety stops the Cape from launching steeper than about 60°: launch along the corridor’s edge, then turn the orbit plane with a burn normal to it where the orbit crosses the equator.',
  briefingDistances: { orbit: { kind: 'altitude', body: 'earth', value: 400e3 } },
  epoch: JAN_2027,
  start: launchStart('cape-canaveral', 400e3),
  rules: launchRules('plane-change', 400e3),
  spacecraft: { wetMass: 6000, dryMass: 2500, engines: [{ thrust: 25e3, isp: 320 }] },
  maxDuration: 1 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['plane-change'],
  objectives: [
    { kind: 'orbit', body: 'earth', periapsis: altitudeBand('earth', 350e3, 450e3), apoapsis: altitudeBand('earth', 350e3, 450e3), inclination: [64, 66], reference: 'equator', revolutions: 3 },
    { kind: 'max-delta-v', max: loosestLimits('plane-change').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('plane-change').maxTime },
  ],
  scoring: par(719.3, 22106),
};

export const EARTH_ESCAPE: CompleteMission = {
  id: 'earth-escape', title: 'Escape', version: 3,
  briefing: 'Leave Earth for good with at least 3 km/s to spare (hyperbolic excess speed). Your stage pushes only 5 kN: one long burn spends its thrust far from perigee. Split the work over several perigee passes, raising apogee each time, so every burn happens deep in Earth’s gravity where it counts most.',
  epoch: JAN_2027,
  start: launchStart('cape-canaveral', 300e3),
  rules: launchRules('earth-escape', 300e3),
  spacecraft: { wetMass: 5000, dryMass: 1300, engines: [{ thrust: 5e3, isp: 320 }] },
  maxDuration: 4 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['earth-escape'],
  objectives: [
    { kind: 'escape', body: 'earth', minSpeed: 3000 },
    { kind: 'max-delta-v', max: loosestLimits('earth-escape').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('earth-escape').maxTime },
  ],
  scoring: par(3665.5, 110024),
};

export const LUNAR_ORBIT: CompleteMission = {
  id: 'lunar-orbit', title: 'Lunar orbit', version: 3,
  briefing: 'Enter orbit around the Moon (periselene {peri}, aposelene below {apo}) and stay for three revolutions. This stage is weak: the injection takes a quarter of an hour, so centre it on the right point, aim for a low pass, and brake at periselene.',
  briefingDistances: { peri: { kind: 'altitude-band', body: 'moon', lo: 50e3, hi: 500e3 }, apo: { kind: 'altitude', body: 'moon', value: 5000e3 } },
  epoch: JAN_2027,
  start: launchStart('kourou'),
  rules: { ...launchRules('lunar-orbit'), window: [JAN_2027, JAN_2027 + 60 * DAY] },
  spacecraft: { wetMass: 26000, dryMass: 9000, engines: [{ thrust: 60e3, isp: 450 }] },
  maxDuration: 6 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['lunar-orbit'],
  objectives: [
    { kind: 'orbit', body: 'moon', periapsis: altitudeBand('moon', 50e3, 500e3), apoapsis: altitudeBand('moon', 50e3, 5000e3), revolutions: 3 },
    { kind: 'max-delta-v', max: loosestLimits('lunar-orbit').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('lunar-orbit').maxTime },
  ],
  scoring: par(4201.2, 250814),
};

const PROBE = { wetMass: 10000, dryMass: 2500, engines: [{ thrust: 60e3, isp: 450 }] };

export const VENUS_FLYBY: CompleteMission = {
  id: 'venus-flyby', title: 'Venus flyby', version: 3,
  briefing: 'Fly past Venus ({pass}) in the spring 2028 window. Pick a departure date from the porkchop plot, then a launch site, time and azimuth whose parking orbit contains the departure direction: it lies 35° north of the equator, so the parking orbit must be inclined at least that much (any site can do it; from Florida a launch along the corridor’s south-east edge).',
  briefingDistances: { pass: { kind: 'altitude-band', body: 'venus', lo: 300e3, hi: 30000e3 } },
  epoch: utcTdb(2028, 3, 20),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('venus-flyby'), window: [utcTdb(2027, 10, 1), utcTdb(2028, 6, 1)] },
  spacecraft: PROBE,
  maxDuration: 260 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['venus-flyby'],
  objectives: [
    { kind: 'flyby', body: 'venus', minAltitude: 300e3, maxAltitude: 30000e3 },
    { kind: 'max-delta-v', max: loosestLimits('venus-flyby').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('venus-flyby').maxTime },
  ],
  scoring: par(3659.8, 14901542),
};

export const MARS_FLYBY: CompleteMission = {
  id: 'mars-flyby', title: 'Mars flyby', version: 3,
  briefing: 'Fly past Mars ({pass}) in the 2028-29 window. The 30 kN engine needs a 14-minute departure burn: plan it as a finite burn centred on the ideal departure point.',
  briefingDistances: { pass: { kind: 'altitude-band', body: 'mars', lo: 200e3, hi: 20000e3 } },
  epoch: utcTdb(2028, 11, 20),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('mars-flyby'), window: [utcTdb(2028, 9, 1), utcTdb(2029, 3, 1)] },
  spacecraft: { wetMass: 10000, dryMass: 2500, engines: [{ thrust: 30e3, isp: 450 }] },
  maxDuration: 400 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['mars-flyby'],
  objectives: [
    { kind: 'flyby', body: 'mars', minAltitude: 200e3, maxAltitude: 20000e3 },
    { kind: 'max-delta-v', max: loosestLimits('mars-flyby').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('mars-flyby').maxTime },
  ],
  scoring: par(3713.2, 27334261),
};

export const MARS_ORBIT: CompleteMission = {
  id: 'mars-orbit', title: 'Mars orbit', version: 3,
  briefing: 'Capture into an elliptical orbit around Mars (periapsis {peri}, apoapsis {apo}) and hold it for two revolutions. After ten months of cruise a small midcourse correction a month out puts periapsis where you want it; then brake there.',
  briefingDistances: { peri: { kind: 'altitude-band', body: 'mars', lo: 200e3, hi: 1000e3 }, apo: { kind: 'altitude-band', body: 'mars', lo: 5000e3, hi: 40000e3 } },
  epoch: utcTdb(2028, 11, 20),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('mars-orbit'), window: [utcTdb(2028, 9, 1), utcTdb(2029, 3, 1)] },
  spacecraft: { wetMass: 12000, dryMass: 3000, engines: [{ thrust: 60e3, isp: 450 }] },
  maxDuration: 400 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['mars-orbit'],
  objectives: [
    { kind: 'orbit', body: 'mars', periapsis: altitudeBand('mars', 200e3, 1000e3), apoapsis: altitudeBand('mars', 5000e3, 40000e3), revolutions: 2 },
    { kind: 'max-delta-v', max: loosestLimits('mars-orbit').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('mars-orbit').maxTime },
  ],
  scoring: par(4878.2, 26066288),
};

export const VENUS_TO_MERCURY: CompleteMission = {
  id: 'venus-to-mercury', title: 'Venus to Mercury', version: 3,
  briefing: 'Reach Mercury slowly enough to matter: pass it below {pass} at under 13 km/s, after a flyby of Venus. Going straight to Mercury costs about the same to leave Earth but arrives near 16 km/s; Venus’s gravity bends the path for free. Launch in late 2031.',
  briefingDistances: { pass: { kind: 'altitude', body: 'mercury', value: 50_000e3 } },
  epoch: utcTdb(2031, 10, 20),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('venus-to-mercury'), window: [utcTdb(2031, 8, 1), utcTdb(2032, 1, 1)] },
  spacecraft: { wetMass: 12000, dryMass: 2500, engines: [{ thrust: 60e3, isp: 450 }] },
  maxDuration: 450 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['venus-to-mercury'],
  objectives: [
    { kind: 'sequence', steps: [
      { kind: 'flyby', body: 'venus', minAltitude: 300e3, maxAltitude: 200_000e3 },
      { kind: 'flyby', body: 'mercury', minAltitude: 200e3, maxAltitude: 50_000e3, maxSpeed: 13_000 },
    ] },
    { kind: 'max-delta-v', max: loosestLimits('venus-to-mercury').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('venus-to-mercury').maxTime },
  ],
  scoring: par(5144.4, 28963878),
};

const HEAVY = { wetMass: 45000, dryMass: 7000, engines: [{ thrust: 200e3, isp: 450 }] };

export const SOLAR_ESCAPE: CompleteMission = {
  id: 'solar-escape', title: 'Leave the Sun', version: 3,
  briefing: 'Leave the solar system with at least 7.5 km/s of excess speed over the Sun. Your stage cannot do it alone: fly behind Jupiter, so its gravity turns your path toward the direction Jupiter is moving and hands you some of its orbital speed. Launch in 2031 or 2032.',
  epoch: utcTdb(2031, 1, 1),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('solar-escape'), window: [utcTdb(2031, 1, 1), utcTdb(2033, 1, 1)] },
  spacecraft: HEAVY,
  maxDuration: 4 * YEAR,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['solar-escape'],
  objectives: [
    { kind: 'escape', body: 'sun', minSpeed: 7500 },
    { kind: 'max-delta-v', max: loosestLimits('solar-escape').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('solar-escape').maxTime },
  ],
  scoring: par(6578.7, 71779226),
};

export const JUPITER_SATURN: CompleteMission = {
  id: 'jupiter-saturn', title: 'Jupiter to Saturn', version: 3,
  briefing: 'Fly past Jupiter and on to Saturn (below {pass}) in under 7.4 years. The planets line up for this only about every 20 years; launch in 2034, aim the Jupiter flyby so it bends you toward where Saturn will be, and trim the path after the flyby.',
  briefingDistances: { pass: { kind: 'altitude', body: 'saturn', value: 2_000_000e3 } },
  epoch: utcTdb(2034, 6, 10),
  start: launchStart('cape-canaveral'),
  rules: { ...launchRules('jupiter-saturn'), window: [utcTdb(2034, 1, 1), utcTdb(2035, 1, 1)] },
  spacecraft: HEAVY,
  maxDuration: 8 * YEAR,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['jupiter-saturn'],
  objectives: [
    { kind: 'sequence', steps: [
      { kind: 'flyby', body: 'jupiter', minAltitude: 100e3, maxAltitude: 1_000_000e3 },
      { kind: 'flyby', body: 'saturn', minAltitude: 1000e3, maxAltitude: 2_000_000e3 },
    ] },
    { kind: 'max-delta-v', max: loosestLimits('jupiter-saturn').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('jupiter-saturn').maxTime },
  ],
  scoring: par(6710.7, 201753561),
};

/** The campaign in play order (rising difficulty). */
export const CAMPAIGN: readonly CompleteMission[] = [
  PLANE_CHANGE,
  GEO_FROM_LEO,
  EARTH_ESCAPE,
  LUNAR_FLYBY,
  LUNAR_FREE_RETURN,
  LUNAR_ORBIT,
  VENUS_FLYBY,
  MARS_FLYBY,
  MARS_ORBIT,
  VENUS_TO_MERCURY,
  SOLAR_ESCAPE,
  JUPITER_SATURN,
];

/** A campaign mission by id. */
export function campaignMission(id: string): CompleteMission | undefined {
  return CAMPAIGN.find((m) => m.id === id);
}
