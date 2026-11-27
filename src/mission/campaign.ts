/**
 * The campaign: twelve authored missions on the real ephemeris, in rising
 * difficulty, each teaching one idea. Complete definitions (start, rules,
 * vehicle, spacecraft, limits, scoring), so the editor and a leaderboard
 * need nothing else; a leaderboard keys on `id` + `version`.
 *
 * LAUNCH VEHICLES (version 4; plane-change version 3). Every mission flies a
 * staged vehicle: a catalogue launcher (vehicles.ts, unmodified, bit for bit)
 * below the mission's spacecraft (rules.vehicle). The ascent is computed by
 * the ascent model (ascent.ts) and charged: what the upper stage has left at
 * insertion depends on the site (Earth's rotation), the azimuth (inclination)
 * and the parking altitude, which the player chooses inside PARKING_BAND
 * (180-1 000 km). Scoring and the delta-v limits are on the total delta-v
 * (ReplayResult.totalDeltaV: the ascent plus everything flown after it).
 * The spacecraft masses were sized with the ascent model so that from the
 * default site, launched well (lowest sensible inclination, low orbit), the
 * upper stage can fly the departure with a margin that shrinks through the
 * campaign; launched badly it runs short and the spacecraft has to finish the
 * burn (a split across the separation), from a spacecraft whose own reserve
 * also shrinks through the campaign. What each choice teaches:
 *  - plane-change, Soyuz-2.1b + 7.5 t (25 kN): inclination is cheap in the
 *    ascent (~8 m/s per degree at the Cape) and dear in orbit (~134 m/s per
 *    degree): use the corridor's edge, then let the upper stage turn the last
 *    ~5°. Launching to 180 km and turning in the circularisation at 400 km
 *    (10 066 m/s) beats launching straight to 400 km and turning there
 *    (10 135 m/s), which the limit (10 130 m/s) refuses; a pure in-orbit
 *    plane change fails by kilometres per second (mission-campaign-solve.test.ts).
 *    The briefing asks the question and does not answer it.
 *  - geo-from-leo, Ariane 5 ECA + 10 t: the hydrogen upper stage flies the
 *    transfer burn (GTO) with ~10 % to spare from Kourou; the satellite
 *    circularises and removes the inclination. An equatorial site pays twice.
 *  - earth-escape, Soyuz-2.1b + 5 t (5 kN): a strong first kick, then a weak
 *    stage that must split the rest over perigee passes.
 *  - lunar-flyby / free-return, Falcon 9 + 6.5 t: the upper stage flies the
 *    injection with ~8 % to spare if launched into the Moon's plane.
 *  - lunar-orbit, Ariane 5 ECA + 7.4 t: the low-thrust ESC-A makes the
 *    injection a ten-minute burn; the spacecraft brakes at periselene.
 *  - venus-flyby, Atlas V 401 + 2.75 t: the Centaur has ~6 % over the
 *    departure; the 35° asymptote costs the ascent rotation credit; the probe
 *    carries ~1 km/s.
 *  - mars-flyby, Falcon 9 + 4.85 t: ~6 % reserve, a probe with ~800 m/s.
 *  - mars-orbit, Falcon 9 + 5.1 t orbiter: every m/s the upper stage falls
 *    short comes out of the capture margin (orbiter ~1.7 km/s for a ~1.2 km/s
 *    capture).
 *  - venus-to-mercury, Atlas V 401 + 1.4 t: ~4 % reserve, a probe with ~500 m/s.
 *  - solar-escape / jupiter-saturn, Ariane 5 ECA + 8 t kick stage (30 kN):
 *    no launcher does these departures alone: the upper stage burns out,
 *    separates, and the kick stage finishes the same burn.
 *
 * INSERTION TIME (an approximation, kept for now). Whatever the vehicle and
 * the chosen altitude, the spacecraft appears in its parking orbit 540 s
 * after liftoff, 13.5° downrange (DEFAULT_ASCENT_TIME_S, DEFAULT_DOWNRANGE_DEG,
 * fixed by rules.vehicle). The ascent model decides the energy (what the
 * upper stage has left), not the timing: a real ascent to 1 000 km would
 * coast for longer and insert further downrange. This shifts only the phase
 * of the parking orbit (when the player reaches a node), not what any orbit
 * costs, and is the same for every player, so it does not favour one plan.
 *
 * HOW THE NUMBERS WERE SET. Every (mission, site) pair was solved through the
 * plan -> replay path with the shared solvers (test/helpers/campaign-solvers.ts:
 * the parking altitude chosen with the ascent model, the departure flown by
 * the upper stage and split across a separation when it runs dry, the upper
 * stage dropped after the departure); the plans are kept only in
 * test/fixtures/campaign-solutions.json. From each solution:
 *  - max delta-v = ascent + flight x 1.08, rounded up to 10 m/s: the 8 % is
 *    room for finite-burn losses and a player's less precise timing on the
 *    FLIGHT (as before); on the ascent the site's own reference already
 *    allows for the site, and 8 % of a 9 km/s ascent (over 700 m/s) would
 *    allow a different launch altogether. The three sample missions keep
 *    their original ratios (geo 1.145, lunar flyby 1.105, free return 1.042,
 *    tight by design: the budget covers the injection only);
 *  - max time = par x 1.25 near Earth (rounded up to 10 minutes; the samples
 *    keep their flat limits), x 1.15 for interplanetary missions (rounded up
 *    to the day), never above maxDuration;
 *  - par (scoring refs) = the best offered site's reference (lowest total
 *    delta-v; parSite), total delta-v and time, weights 1:1, stored in the
 *    leaderboard's quantised units (delta-v rounded up to 0.1 m/s, time up
 *    to the second, as deltaVKey / timeKey), so flying the reference scores
 *    exactly PAR_SCORE (10 000); each mission
 *    opens at that site. plane-change: the Cape, the site it is about.
 *
 * HEADROOM PAR LEAVES. The references drop the upper stage ten minutes after
 * the departure with what it has left (a player can spend it and beat par).
 * Left in the upper stage in the par reference, and its delta-v with the
 * spacecraft still attached:
 *    plane-change 461 kg (~160 m/s)       geo-from-leo 920 kg (~270 m/s)
 *    earth-escape 0 (burnt out)           lunar-flyby 783 kg (~245 m/s)
 *    lunar-free-return 697 kg (~220 m/s)  lunar-orbit 496 kg (~180 m/s)
 *    venus-flyby 319 kg (~270 m/s)        mars-flyby 843 kg (~310 m/s)
 *    mars-orbit 587 kg (~215 m/s)         venus-to-mercury 329 kg (~375 m/s)
 *    solar-escape, jupiter-saturn 0 (the upper stage burns out; the kick
 *    stage finishes the departure)
 * Altitudes in objectives are above each body's reference (equatorial)
 * radius (altitudeBand); inclination is measured against the pole the
 * physics uses at that time.
 *
 * LAUNCH SITES. The player chooses the site: latitude decides the reachable
 * inclinations, the range-safety corridor the azimuths, longitude the
 * timing, and now the ascent too (rotation credit). `launchSites`
 * (campaign-sites.ts) lists every site with its own reference solution and
 * limits, or why it is not offered; `rules.sites` is the offered list and the
 * max-delta-v / max-time objectives carry the loosest offered limits
 * (evaluate applies the plan's own site's). Scoring keeps ONE par per mission
 * for every site, so the all-sites leaderboard compares sites directly and a
 * better site scores better. plane-change stays at Cape Canaveral: its lesson
 * is the Cape's corridor.
 */
import { CAMPAIGN_SITES, loosestLimits, offeredSites, parSite, sitePar } from './campaign-sites';
import { vehicleLaunch, type Band, type CompleteMission } from './objectives';
import { J2000_BODIES } from '../physics/solar-system';
import { GEO_FROM_LEO, JAN_2027, LUNAR_FLYBY, LUNAR_FREE_RETURN } from './samples';
import { catalogueStages, PARKING_BAND } from './vehicles';

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
const launchStart = (site: string, azimuthDeg = 90, altitudeM = 200e3) => ({ kind: 'launch' as const, site, azimuthDeg, altitudeM });
/** Launch rules: site list, launch only, and the mission's launch vehicle with the allowed parking-orbit band. */
const launchRules = (id: string, vehicle: string) => ({ launchOnly: true, sites: offeredSites(id), vehicle: vehicleLaunch(catalogueStages(vehicle), PARKING_BAND) });

export const PLANE_CHANGE: CompleteMission = {
  id: 'plane-change', title: 'Plane change', version: 3,
  briefing: 'Reach a circular orbit at {orbit}, inclined 64-66° to the equator, from Cape Canaveral on a Soyuz. Range safety stops the Cape from launching steeper than about 60°, so the last few degrees have to be turned after launch. You can steer some of the inclination in the ascent, and turn the rest in orbit; you can launch straight to {orbit}, or launch lower and climb. Each choice moves the bill between the launcher and the upper stage. Which combination is cheapest?',
  briefingDistances: { orbit: { kind: 'altitude', body: 'earth', value: 400e3 } },
  epoch: JAN_2027,
  start: launchStart('cape-canaveral', 35, 400e3),
  rules: launchRules('plane-change', 'soyuz-2-1b'),
  spacecraft: { wetMass: 7500, dryMass: 3750, engines: [{ thrust: 25e3, isp: 320 }] },
  maxDuration: 1 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['plane-change'],
  objectives: [
    { kind: 'orbit', body: 'earth', periapsis: altitudeBand('earth', 350e3, 450e3), apoapsis: altitudeBand('earth', 350e3, 450e3), inclination: [64, 66], reference: 'equator', revolutions: 3 },
    { kind: 'max-delta-v', max: loosestLimits('plane-change').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('plane-change').maxTime },
  ],
  scoring: sitePar('plane-change', 'cape-canaveral'),
};

export const EARTH_ESCAPE: CompleteMission = {
  id: 'earth-escape', title: 'Escape', version: 4,
  briefing: 'Leave Earth for good with at least 3 km/s to spare (hyperbolic excess speed). The Soyuz upper stage gives you a strong first kick; after it separates, your own stage pushes only 5 kN, and one long burn would spend its thrust far from perigee. Split the rest over several perigee passes, raising apogee each time, so every burn happens deep in Earth’s gravity where it counts most.',
  epoch: JAN_2027,
  start: launchStart(parSite('earth-escape')),
  rules: launchRules('earth-escape', 'soyuz-2-1b'),
  spacecraft: { wetMass: 5000, dryMass: 2000, engines: [{ thrust: 5e3, isp: 320 }] },
  maxDuration: 4 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['earth-escape'],
  objectives: [
    { kind: 'escape', body: 'earth', minSpeed: 3000 },
    { kind: 'max-delta-v', max: loosestLimits('earth-escape').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('earth-escape').maxTime },
  ],
  scoring: sitePar('earth-escape', parSite('earth-escape')),
};

export const LUNAR_ORBIT: CompleteMission = {
  id: 'lunar-orbit', title: 'Lunar orbit', version: 4,
  briefing: 'Enter orbit around the Moon (periselene {peri}, aposelene below {apo}) and stay for three revolutions. Ariane’s hydrogen upper stage is efficient but weak: the injection takes about ten minutes, so centre it on the right point and aim for a low pass. Then separate it; your spacecraft brakes at periselene.',
  briefingDistances: { peri: { kind: 'altitude-band', body: 'moon', lo: 50e3, hi: 500e3 }, apo: { kind: 'altitude', body: 'moon', value: 5000e3 } },
  epoch: JAN_2027,
  start: launchStart(parSite('lunar-orbit')),
  rules: { ...launchRules('lunar-orbit', 'ariane-5-eca'), window: [JAN_2027, JAN_2027 + 60 * DAY] },
  spacecraft: { wetMass: 7400, dryMass: 4400, engines: [{ thrust: 20e3, isp: 320 }] },
  maxDuration: 6 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['lunar-orbit'],
  objectives: [
    { kind: 'orbit', body: 'moon', periapsis: altitudeBand('moon', 50e3, 500e3), apoapsis: altitudeBand('moon', 50e3, 5000e3), revolutions: 3 },
    { kind: 'max-delta-v', max: loosestLimits('lunar-orbit').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('lunar-orbit').maxTime },
  ],
  scoring: sitePar('lunar-orbit', parSite('lunar-orbit')),
};

export const VENUS_FLYBY: CompleteMission = {
  id: 'venus-flyby', title: 'Venus flyby', version: 4,
  briefing: 'Fly past Venus ({pass}) in the spring 2028 window on an Atlas V. Pick a departure date from the porkchop plot, then a launch site, time and azimuth whose parking orbit contains the departure direction: it lies 35° north of the equator, so the parking orbit must be inclined at least that much, which costs the ascent some of Earth’s rotation. The Centaur has just enough for the departure if you launch well; your probe’s small engine can make up only a little.',
  briefingDistances: { pass: { kind: 'altitude-band', body: 'venus', lo: 300e3, hi: 30000e3 } },
  epoch: utcTdb(2028, 3, 20),
  start: launchStart(parSite('venus-flyby')),
  rules: { ...launchRules('venus-flyby', 'atlas-v-401'), window: [utcTdb(2027, 10, 1), utcTdb(2028, 6, 1)] },
  spacecraft: { wetMass: 2750, dryMass: 2000, engines: [{ thrust: 4e3, isp: 320 }] },
  maxDuration: 260 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['venus-flyby'],
  objectives: [
    { kind: 'flyby', body: 'venus', minAltitude: 300e3, maxAltitude: 30000e3 },
    { kind: 'max-delta-v', max: loosestLimits('venus-flyby').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('venus-flyby').maxTime },
  ],
  scoring: sitePar('venus-flyby', parSite('venus-flyby')),
};

export const MARS_FLYBY: CompleteMission = {
  id: 'mars-flyby', title: 'Mars flyby', version: 4,
  briefing: 'Fly past Mars ({pass}) in the 2028-29 window on a Falcon 9. Its upper stage can just make the departure from a low parking orbit launched close to due east; a higher orbit or a steeper launch leaves it short, and your probe carries only about 800 m/s for the difference and the corrections.',
  briefingDistances: { pass: { kind: 'altitude-band', body: 'mars', lo: 200e3, hi: 20000e3 } },
  epoch: utcTdb(2028, 11, 20),
  start: launchStart(parSite('mars-flyby')),
  rules: { ...launchRules('mars-flyby', 'falcon-9'), window: [utcTdb(2028, 9, 1), utcTdb(2029, 3, 1)] },
  spacecraft: { wetMass: 4850, dryMass: 3750, engines: [{ thrust: 4e3, isp: 320 }] },
  maxDuration: 400 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['mars-flyby'],
  objectives: [
    { kind: 'flyby', body: 'mars', minAltitude: 200e3, maxAltitude: 20000e3 },
    { kind: 'max-delta-v', max: loosestLimits('mars-flyby').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('mars-flyby').maxTime },
  ],
  scoring: sitePar('mars-flyby', parSite('mars-flyby')),
};

export const MARS_ORBIT: CompleteMission = {
  id: 'mars-orbit', title: 'Mars orbit', version: 4,
  briefing: 'Capture into an elliptical orbit around Mars (periapsis {peri}, apoapsis {apo}) and hold it for two revolutions. The Falcon 9 upper stage does the departure; your orbiter must keep its propellant for the capture, so every m/s the upper stage falls short comes out of the capture margin. After ten months of cruise a small midcourse correction a month out puts periapsis where you want it; then brake there.',
  briefingDistances: { peri: { kind: 'altitude-band', body: 'mars', lo: 200e3, hi: 1000e3 }, apo: { kind: 'altitude-band', body: 'mars', lo: 5000e3, hi: 40000e3 } },
  epoch: utcTdb(2028, 11, 20),
  start: launchStart(parSite('mars-orbit')),
  rules: { ...launchRules('mars-orbit', 'falcon-9'), window: [utcTdb(2028, 9, 1), utcTdb(2029, 3, 1)] },
  spacecraft: { wetMass: 5100, dryMass: 2950, engines: [{ thrust: 10e3, isp: 320 }] },
  maxDuration: 400 * DAY,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['mars-orbit'],
  objectives: [
    { kind: 'orbit', body: 'mars', periapsis: altitudeBand('mars', 200e3, 1000e3), apoapsis: altitudeBand('mars', 5000e3, 40000e3), revolutions: 2 },
    { kind: 'max-delta-v', max: loosestLimits('mars-orbit').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('mars-orbit').maxTime },
  ],
  scoring: sitePar('mars-orbit', parSite('mars-orbit')),
};

export const VENUS_TO_MERCURY: CompleteMission = {
  id: 'venus-to-mercury', title: 'Venus to Mercury', version: 4,
  briefing: 'Reach Mercury slowly enough to matter: pass it below {pass} at under 13 km/s, after a flyby of Venus. Going straight to Mercury costs about the same to leave Earth but arrives near 16 km/s; Venus’s gravity bends the path for free. Launch in late 2031 on an Atlas V: the Centaur has the departure with a few per cent to spare, and your light probe has only about 500 m/s, so launch well.',
  briefingDistances: { pass: { kind: 'altitude', body: 'mercury', value: 50_000e3 } },
  epoch: utcTdb(2031, 10, 20),
  start: launchStart(parSite('venus-to-mercury')),
  rules: { ...launchRules('venus-to-mercury', 'atlas-v-401'), window: [utcTdb(2031, 8, 1), utcTdb(2032, 1, 1)] },
  spacecraft: { wetMass: 1400, dryMass: 1200, engines: [{ thrust: 2e3, isp: 320 }] },
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
  scoring: sitePar('venus-to-mercury', parSite('venus-to-mercury')),
};

/**
 * Kick stage for the outer planets: on an Ariane 5 ECA it finishes a departure the ESC-A upper stage starts.
 * Our own example stage, not a real one: its dry mass was lowered from 3450 kg to 3100 kg while the
 * references were derived (version 4), so the split departures to solar escape and Jupiter close with a margin.
 */
const HEAVY = { wetMass: 8000, dryMass: 3100, engines: [{ thrust: 30e3, isp: 450 }] };

export const SOLAR_ESCAPE: CompleteMission = {
  id: 'solar-escape', title: 'Leave the Sun', version: 4,
  briefing: 'Leave the solar system with at least 7.5 km/s of excess speed over the Sun. Even an Ariane 5 cannot do it alone: its upper stage gives about half the departure, then separates and your kick stage burns the rest in the same pass. Then fly behind Jupiter, so its gravity turns your path toward the direction Jupiter is moving and hands you some of its orbital speed. Launch in 2031 or 2032.',
  epoch: utcTdb(2031, 1, 1),
  start: launchStart(parSite('solar-escape')),
  rules: { ...launchRules('solar-escape', 'ariane-5-eca'), window: [utcTdb(2031, 1, 1), utcTdb(2033, 1, 1)] },
  spacecraft: HEAVY,
  maxDuration: 4 * YEAR,
  atmosphereIsFailure: true,
  launchSites: CAMPAIGN_SITES['solar-escape'],
  objectives: [
    { kind: 'escape', body: 'sun', minSpeed: 7500 },
    { kind: 'max-delta-v', max: loosestLimits('solar-escape').maxDeltaV },
    { kind: 'max-time', max: loosestLimits('solar-escape').maxTime },
  ],
  scoring: sitePar('solar-escape', parSite('solar-escape')),
};

export const JUPITER_SATURN: CompleteMission = {
  id: 'jupiter-saturn', title: 'Jupiter to Saturn', version: 4,
  briefing: 'Fly past Jupiter and on to Saturn (below {pass}) in under 7.4 years. The planets line up for this only about every 20 years; launch in 2034. The departure is split across a separation: the Ariane upper stage burns out, your kick stage finishes it. Aim the Jupiter flyby so it bends you toward where Saturn will be, and trim the path after the flyby with what the kick stage has left.',
  briefingDistances: { pass: { kind: 'altitude', body: 'saturn', value: 2_000_000e3 } },
  epoch: utcTdb(2034, 6, 10),
  start: launchStart(parSite('jupiter-saturn')),
  rules: { ...launchRules('jupiter-saturn', 'ariane-5-eca'), window: [utcTdb(2034, 1, 1), utcTdb(2035, 1, 1)] },
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
  scoring: sitePar('jupiter-saturn', parSite('jupiter-saturn')),
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
