/**
 * Mission catalogue for the picker: sandbox plus the sample missions from
 * src/mission/samples.ts, flown in the real ephemeris world. Each keeps its
 * objectives, limits and scoring; the pre-tuned burns those samples were
 * tested with (on simplified worlds) are not used: a mission starts with a
 * default launch and spacecraft and no burns, and the player solves it.
 *
 * Also: spacecraft presets and plan factories. Pure.
 */
import { DEFAULT_ASCENT_TIME_S, SAMPLE_MISSIONS, launchToParams, makePlan, type MissionDefinition, type MissionPlan, type Spacecraft } from './mission-layer';
import { calendarToTdb, DAY } from './time';

export interface SpacecraftPreset {
  id: string;
  label: string;
  craft: Spacecraft;
}

/** Rough, rounded figures in the spirit of real vehicles; for play, not reference. */
export const SPACECRAFT_PRESETS: readonly SpacecraftPreset[] = [
  { id: 'tli-stage', label: 'Lunar injection stage (30 t, 200 kN, 450 s)', craft: { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] } },
  { id: 'kick-stage', label: 'Hydrolox kick stage (23 t, 100 kN, 450 s)', craft: { wetMass: 23000, dryMass: 2500, engines: [{ thrust: 100e3, isp: 450 }] } },
  { id: 'service-module', label: 'Service module (30 t, 90 kN, 314 s + RCS)', craft: { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 91e3, isp: 314 }, { thrust: 1800, isp: 280 }] } },
  { id: 'probe', label: 'Interplanetary probe (2 t, 400 N, 320 s)', craft: { wetMass: 2000, dryMass: 900, engines: [{ thrust: 400, isp: 320 }] } },
];

export interface LaunchDefaults {
  site: string;
  /** Liftoff, TDB s from J2000. */
  time: number;
  azimuthDeg: number;
  altitudeM: number;
}

export interface MissionEntry {
  id: string;
  title: string;
  /** Null for sandbox (no objectives). */
  def: MissionDefinition | null;
  blurb: string;
  launch: LaunchDefaults;
  duration: number;
  craft: Spacecraft;
}

const JAN_2027 = calendarToTdb({ year: 2027, month: 1, day: 10, hour: 12, minute: 0, second: 0 });

function sample(id: string): MissionDefinition {
  const m = SAMPLE_MISSIONS.find((x) => x.id === id);
  if (!m) throw new Error(`sample mission ${id} missing`);
  return m;
}

export const MISSIONS: readonly MissionEntry[] = [
  {
    id: 'sandbox',
    title: 'Sandbox',
    def: null,
    blurb: 'No objectives. Launch or start in any orbit and fly.',
    launch: { site: 'cape-canaveral', time: JAN_2027, azimuthDeg: 90, altitudeM: 200e3 },
    duration: 10 * DAY,
    craft: SPACECRAFT_PRESETS[0].craft,
  },
  {
    id: 'geo-from-leo',
    title: sample('geo-from-leo').title,
    def: sample('geo-from-leo'),
    blurb: 'Reach a circular orbit at 42,164 km radius (±100 km), inclined under 1° to the equator, and hold it for three revolutions. At most 4.5 km/s, within 6 days.',
    launch: { site: 'kourou', time: JAN_2027, azimuthDeg: 90, altitudeM: 250e3 },
    duration: 6 * DAY,
    craft: SPACECRAFT_PRESETS[1].craft,
  },
  {
    id: 'lunar-flyby',
    title: sample('lunar-flyby').title,
    def: sample('lunar-flyby'),
    blurb: 'Pass the Moon between 100 km and 10,000 km altitude and keep flying. At most 3.5 km/s, within 7 days.',
    launch: { site: 'kourou', time: JAN_2027, azimuthDeg: 90, altitudeM: 200e3 },
    duration: 7 * DAY,
    craft: SPACECRAFT_PRESETS[0].craft,
  },
  {
    id: 'lunar-free-return',
    title: sample('lunar-free-return').title,
    def: sample('lunar-free-return'),
    blurb: 'One injection burn: fly past the Moon (100 to 20,000 km) and come back into Earth’s atmosphere below 11.5 km/s. At most 3.3 km/s, within 12 days.',
    launch: { site: 'kourou', time: JAN_2027, azimuthDeg: 90, altitudeM: 200e3 },
    duration: 12 * DAY,
    craft: SPACECRAFT_PRESETS[0].craft,
  },
];

export function missionById(id: string): MissionEntry | undefined {
  return MISSIONS.find((m) => m.id === id);
}

export const DEFAULT_RTOL = 1e-10;

/** Launch plan params (see launch.ts launchToParams). */
export function launchParams(l: LaunchDefaults): number[] {
  return launchToParams({ mode: 'parking-orbit', siteId: l.site, launchTime: l.time, azimuthDeg: l.azimuthDeg, altitudeM: l.altitudeM, ascentTimeS: DEFAULT_ASCENT_TIME_S });
}

/** A fresh plan for a mission: its default launch and spacecraft, no burns. */
export function initialPlan(m: MissionEntry, fingerprint: string): MissionPlan {
  return makePlan({
    data: fingerprint,
    epoch: m.launch.time,
    duration: m.duration,
    rtol: DEFAULT_RTOL,
    start: { kind: 'launch', site: m.launch.site, params: launchParams(m.launch) },
    spacecraft: m.craft,
    burns: [],
  });
}

/** Launch fields of a plan with a launch start. */
export function launchOf(plan: MissionPlan): LaunchDefaults | null {
  const s = plan.start;
  if (s.kind !== 'launch') return null;
  return { site: s.site, time: s.params[0], azimuthDeg: s.params[1], altitudeM: s.params[2] };
}

/**
 * Change the launch. The epoch is liftoff (plan.ts TIME RULES), so moving the
 * liftoff moves every burn with it: burns are relative to the epoch.
 */
export function withLaunch(plan: MissionPlan, l: LaunchDefaults): MissionPlan {
  const old = plan.start.kind === 'launch' ? plan.start.params : [];
  const params = launchParams(l);
  for (let i = 3; i < old.length; i++) params[i] = old[i];
  return { ...plan, epoch: l.time, start: { kind: 'launch', site: l.site, params } };
}

/** Free start: a state relative to `center` at `epoch`. */
export function withStateStart(plan: MissionPlan, center: string, epoch: number, state: number[]): MissionPlan {
  return { ...plan, epoch, start: { kind: 'state', center, state } };
}
