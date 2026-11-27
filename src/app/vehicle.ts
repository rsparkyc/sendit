/**
 * Launch-vehicle figures for the editor (pure; display maths with ordinary
 * Math). The plan layer and the replay decide what is flown; this only
 * describes the stack:
 *  - stage names (catalogue vehicles by name, else "Stage n"; the top stage
 *    is always "Spacecraft");
 *  - per stage: masses, engines, thrust-to-weight at ignition and the ideal
 *    delta-v with everything above it as payload; the total budget;
 *  - before a replay: what the ascent left each stage and what the nodes
 *    request of it; after a replay: what each stage used and has left.
 */
import { VEHICLES, vehicleStages, type AscentResult, type MissionPlan, type ReplayResult, type Spacecraft } from './mission-layer';
import { G0, nodesOf } from './nodes';

export interface StageRow {
  index: number;
  name: string;
  /** Short tag for node rows and markers: "S1", "S2", "SC". */
  tag: string;
  wetMass: number;
  dryMass: number;
  propellant: number;
  /** Sum of the engines' vacuum thrust, N, and the flow-weighted Isp, s. */
  thrust: number;
  isp: number;
  /** Mass of everything above this stage (unfired), kg. */
  above: number;
  /** Vacuum thrust / (stack weight at this stage's ignition, Earth g). */
  twr: number;
  /** Ideal delta-v of the full stage with everything above as payload, m/s. */
  deltaV: number;
  isSpacecraft: boolean;
}

const sameStage = (a: Spacecraft, b: Spacecraft) => a.wetMass === b.wetMass && a.dryMass === b.dryMass && a.engines.length === b.engines.length && a.engines.every((e, i) => e.thrust === b.engines[i].thrust && e.isp === b.engines[i].isp);

/** The catalogue vehicle whose stages these are (bit for bit), if any. */
export function catalogueMatch(lower: readonly Spacecraft[] | undefined): { id: string; name: string } | null {
  if (!lower || !lower.length) return null;
  const v = VEHICLES.find((x) => x.stages.length === lower.length && x.stages.every((s, i) => sameStage(s, lower[i])));
  return v ? { id: v.id, name: v.name.replace(/\s*\(.*\)\s*$/, '') } : null;
}

export function stageRows(plan: Pick<MissionPlan, 'spacecraft' | 'lowerStages'>): StageRow[] {
  const stages = vehicleStages(plan);
  const cat = catalogueMatch(plan.lowerStages);
  const n = stages.length;
  return stages.map((s, k) => {
    let above = 0;
    for (let j = k + 1; j < n; j++) above += stages[j].wetMass;
    let thrust = 0;
    let flow = 0;
    for (const e of s.engines) {
      thrust += e.thrust;
      flow += e.thrust / (e.isp * G0);
    }
    const isp = flow > 0 ? thrust / flow / G0 : 0;
    const isSc = k === n - 1;
    const name = isSc ? 'Spacecraft' : cat ? `${cat.name} ${k === n - 2 ? 'upper stage' : `stage ${k + 1}`}` : k === n - 2 && n > 2 ? `Stage ${k + 1} (upper)` : `Stage ${k + 1}`;
    return {
      index: k, name, tag: isSc ? 'SC' : `S${k + 1}`,
      wetMass: s.wetMass, dryMass: s.dryMass, propellant: s.wetMass - s.dryMass,
      thrust, isp, above,
      twr: thrust / ((s.wetMass + above) * G0),
      deltaV: isp * G0 * Math.log((s.wetMass + above) / (s.dryMass + above)),
      isSpacecraft: isSc,
    };
  });
}

export interface StagePlan {
  /** Propellant at the start of the flight (after the ascent for a vehicle launch), kg. */
  atStart: number;
  /** Propellant the nodes request of it, kg (capped by what it has). */
  requested: number;
  left: number;
  /** Ideal delta-v of what is left, everything above as payload, m/s. */
  dvLeft: number;
  /** Used or dropped in the ascent. */
  ascent: 'dropped' | 'reached-orbit' | 'unused' | null;
}

/** Before a replay: the propellant budget of each stage from the ascent and the nodes. */
export function stagePlan(plan: MissionPlan, ascent: AscentResult | null): StagePlan[] {
  const rows = stageRows(plan);
  const infos = nodesOf(plan);
  return rows.map((r, k) => {
    let atStart = r.propellant;
    let asc: StagePlan['ascent'] = null;
    if (ascent && ascent.ok) {
      if (k < ascent.upperStage) { atStart = 0; asc = 'dropped'; }
      else if (k === ascent.upperStage) { atStart = ascent.upperPropellant; asc = 'reached-orbit'; }
      else asc = 'unused';
    }
    let requested = 0;
    for (const x of infos) if (x.stage === k) requested += x.m0 - x.m1;
    const left = Math.max(0, atStart - requested);
    const isp = r.isp;
    const dvLeft = isp * G0 * Math.log((r.dryMass + left + r.above) / (r.dryMass + r.above));
    return { atStart, requested, left, dvLeft, ascent: asc };
  });
}

export interface Totals {
  /** Ideal budget of the whole stack from the pad (sum of stage delta-v). */
  budget: number;
  /** Ascent delta-v (vehicle launch) and the flown delta-v after insertion; total = the ranked quantity. */
  ascent: number;
  flown: number;
  total: number;
}

export function totalsOf(plan: MissionPlan, res: ReplayResult | null): Totals {
  const budget = stageRows(plan).reduce((a, r) => a + r.deltaV, 0);
  if (!res) return { budget, ascent: 0, flown: 0, total: 0 };
  const ascent = res.ascent ? res.ascent.deltaV : 0;
  return { budget, ascent, flown: res.deltaV, total: res.totalDeltaV };
}

/** "S3 → SC": the stage a separation drops and the one that takes over. */
export function separationTag(plan: Pick<MissionPlan, 'spacecraft' | 'lowerStages'>, x: { dropped: number; next: number }): string {
  const rows = stageRows(plan);
  return `${rows[x.dropped]?.tag ?? '?'} → ${rows[x.next]?.tag ?? '?'}`;
}
