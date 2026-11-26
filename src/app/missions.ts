/**
 * Mission catalogue for the picker: sandbox plus the sample missions from
 * src/mission/samples.ts, flown in the real ephemeris world. Each keeps its
 * objectives, limits and scoring; the pre-tuned burns those samples were
 * tested with (on simplified worlds) are not used: a mission starts with a
 * default launch and spacecraft and no burns, and the player solves it.
 *
 * Also: spacecraft presets and plan factories. Pure.
 */
import { CAMPAIGN, checkPlanConformance, DEFAULT_ASCENT_TIME_S, initialMissionPlan, launchToParams, makePlan, type CompleteMission, type ConformanceIssue, type MissionPlan, type Spacecraft } from './mission-layer';
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
  def: CompleteMission | null;
  /** Briefing shown to the player. */
  blurb: string;
  /** Campaign chapter, for grouping the picker. */
  chapter: string;
  launch: LaunchDefaults;
  duration: number;
  craft: Spacecraft;
}

const JAN_2027 = calendarToTdb({ year: 2027, month: 1, day: 10, hour: 12, minute: 0, second: 0 });

/** Chapter of a campaign mission, from where it goes. */
function chapterOf(m: CompleteMission, index: number): string {
  if (index < 3) return 'Earth orbit';
  if (/lunar|moon/.test(m.id)) return 'The Moon';
  return 'Interplanetary';
}

/** Sandbox, then the campaign in its authored order (a progression). */
export const MISSIONS: readonly MissionEntry[] = [
  {
    id: 'sandbox',
    title: 'Sandbox',
    def: null,
    blurb: 'No objectives. Launch or start in any orbit and fly, with any spacecraft.',
    chapter: 'Sandbox',
    launch: { site: 'cape-canaveral', time: JAN_2027, azimuthDeg: 90, altitudeM: 200e3 },
    duration: 10 * DAY,
    craft: SPACECRAFT_PRESETS[0].craft,
  },
  ...CAMPAIGN.map((m, i): MissionEntry => {
    const st = m.start;
    return {
      id: m.id,
      title: `${i + 1}. ${m.title}`,
      def: m,
      blurb: m.briefing,
      chapter: chapterOf(m, i),
      launch: st.kind === 'launch' ? { site: st.site, time: m.epoch, azimuthDeg: st.azimuthDeg, altitudeM: st.altitudeM } : { site: 'cape-canaveral', time: m.epoch, azimuthDeg: 90, altitudeM: 200e3 },
      duration: m.maxDuration,
      craft: m.spacecraft,
    };
  }),
];

export function missionById(id: string): MissionEntry | undefined {
  return MISSIONS.find((m) => m.id === id);
}

export const DEFAULT_RTOL = 1e-10;

/** Launch plan params (see launch.ts launchToParams). */
export function launchParams(l: LaunchDefaults): number[] {
  return launchToParams({ mode: 'parking-orbit', siteId: l.site, launchTime: l.time, azimuthDeg: l.azimuthDeg, altitudeM: l.altitudeM, ascentTimeS: DEFAULT_ASCENT_TIME_S });
}

/** A fresh plan for a mission: its default start, spacecraft and duration, no burns. */
export function initialPlan(m: MissionEntry, fingerprint: string): MissionPlan {
  if (m.def) return initialMissionPlan(m.def, fingerprint);
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

/** Conformance issues of a plan for a mission entry (the mission layer's check). Sandbox: none. */
export function conformance(entry: MissionEntry, plan: MissionPlan): ConformanceIssue[] {
  return entry.def ? checkPlanConformance(entry.def, plan) : [];
}

/** Spacecraft conformance messages only. */
export function spacecraftIssues(entry: MissionEntry, plan: MissionPlan): string[] {
  return conformance(entry, plan).filter((i) => i.code === 'spacecraft').map((i) => i.message);
}

/**
 * Which mission a loaded plan (shared link, saved work) is played as. A plan
 * that does not conform to the mission (spacecraft, start rules, duration;
 * checkPlanConformance) is never scored as that mission: it opens in Sandbox
 * with a notice saying why.
 */
export function missionForLoadedPlan(missionId: string | undefined, plan: MissionPlan): { missionId: string; notice: string | null } {
  const entry = missionById(missionId ?? '') ?? MISSIONS[0];
  const issues = conformance(entry, plan);
  if (issues.length === 0) return { missionId: entry.id, notice: null };
  return { missionId: 'sandbox', notice: `This plan does not follow the rules of "${entry.title}" (${issues[0].message}${issues.length > 1 ? `, and ${issues.length - 1} more` : ''}), so it opened in Sandbox and is not scored as that mission.` };
}

/** Thrust-to-weight at full tanks (Earth g0) and ideal delta-v of each engine on its own. */
export function craftPerformance(sc: Spacecraft): { engine: number; twr: number; dv: number }[] {
  const g0 = 9.80665;
  return sc.engines.map((e, engine) => ({ engine, twr: e.thrust / (sc.wetMass * g0), dv: e.isp * g0 * Math.log(sc.wetMass / sc.dryMass) }));
}
