/**
 * Objective, conformance, scoring and leaderboard-verdict vectors
 * (core/fixtures/generated/objectives.txt) for core/src/mission/{objectives,verify}.rs.
 *
 *  - `key` / `cmp`: score, deltaVKey, timeKey and compareKeys, with values
 *    exactly at and one ulp either side of the quantisation boundaries.
 *  - `sites`: campaign-sites.ts (parSite, sitePar, offeredSites,
 *    loosestLimits), allowedSites and missionForSite for every campaign
 *    mission and site, and the mission's own scoring and limit objectives.
 *  - replays: the replay corpus (core/ts/replay-corpus.ts), each evaluated
 *    against its campaign mission (with and without the plan) and against
 *    probe missions built from its own events (every objective kind, bands
 *    exactly at an event's altitude / distance / speed and one ulp inside or
 *    outside, sequences, unknown bodies, par-scoring and limits exactly at
 *    the flight's delta-v and time).
 *  - `conf`: checkPlanConformance and the leaderboard's checkRules for
 *    non-conforming plans (wrong vehicle, site, parking altitude, launch
 *    parameters, engine flags, spacecraft, duration, older mission
 *    version, state starts, direct injection) against the campaign missions
 *    and synthetic rule variants of them.
 *  - `verify`: the leaderboard's verdict (server/leaderboard/engine.ts with
 *    service.ts's submit order) for every reference plan and initial plan and
 *    for rejected submissions (unknown mission, old version, undecodable,
 *    data mismatch, rule violations, over budget).
 * Missions are named `c:<id>` (the campaign definition in core/data) or
 * `j:<hex of exact JSON>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { exactJson, Lines } from './shared';
import { CAMPAIGN } from '../../src/mission/campaign';
import { CAMPAIGN_SITES, loosestLimits, offeredSites, parSite, sitePar } from '../../src/mission/campaign-sites';
import { LAUNCH_SITES } from '../../src/mission/launch';
import { encodePlan, makePlan, type MissionPlan } from '../../src/mission/plan';
import { replay, type ReplayResult } from '../../src/mission/replay';
import {
  allowedSites, checkPlanConformance, compareKeys, deltaVKey, evaluate, initialMissionPlan, missionForSite, score, timeKey,
  type Board, type CompleteMission, type MissionDefinition, type Objective,
} from '../../src/mission/objectives';
import { bodyIndexOf } from '../../src/mission/world';
import { realWorld } from '../../test/helpers/real-world';
import { solutionPlan, SOLUTIONS } from '../../test/helpers/campaign-solutions';
import { checkRules, createEngine, PlanError } from '../../server/leaderboard/engine';
import { replayCorpus, replayRecord } from './replay-corpus';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';
const dv = new DataView(new ArrayBuffer(8));
function step(x: number, d: 1 | -1): number {
  if (Number.isNaN(x) || x === (d > 0 ? Infinity : -Infinity)) return x;
  if (x === 0) return d * 5e-324;
  dv.setFloat64(0, x);
  let b = dv.getBigUint64(0);
  b = (x > 0) === (d > 0) ? b + 1n : b - 1n;
  dv.setBigUint64(0, b);
  return dv.getFloat64(0);
}
const up = (x: number) => step(x, 1);
const down = (x: number) => step(x, -1);

it('export objective vectors', () => {
  const W = new Lines();
  const { world } = realWorld();
  const fp = world.fingerprint;
  const campaignIds = new Set(CAMPAIGN.map((m) => m.id));
  const mref = (m: MissionDefinition) => (campaignIds.has(m.id) && CAMPAIGN.includes(m as CompleteMission) ? `c:${m.id}` : `j:${hex(exactJson(m))}`);

  // ---- score, keys, compareKeys
  const weights = [
    { deltaVRef: 10065.6, deltaVWeight: 1, timeRef: 21871, timeWeight: 1 },
    { deltaVRef: 1234.5, deltaVWeight: 3, timeRef: 86400, timeWeight: 1 },
    { deltaVRef: 0.1, deltaVWeight: 1, timeRef: 1, timeWeight: 0 },
    { deltaVRef: 100, deltaVWeight: 0, timeRef: 100, timeWeight: 0 },
    { deltaVRef: 100, deltaVWeight: -1, timeRef: 100, timeWeight: 1 },
  ];
  const dvs: number[] = [0, -0, -0.05, 0.1, 0.3, 0.1 * 3, 0.7, 1e-300, 5e-324, NaN, 1e300, 12656.1, 10065.6, 13719.4, 9295.0, 123456.7];
  for (let k = 1; k <= 400; k++) dvs.push(k / 10, (k * 37) / 10 + 9000);
  const ts: number[] = [0, -0, -0.5, 0.5, 1, 21871, 201707865, 1e-300, NaN, 1e12];
  for (let k = 0; k < 60; k++) ts.push(k * 977 + 0.5, k * 86400);
  const ext = (a: number[]) => a.flatMap((x) => [x, up(x), down(x)]);
  const DV = ext(dvs);
  const T = ext(ts);
  let i = 0;
  for (const d of DV) {
    const t = T[i % T.length];
    const w = weights[i % weights.length];
    i++;
    for (const succ of [true, false]) if (succ || i % 7 === 0) W.add('key', succ ? 'ok' : 'fail', d, t, w.deltaVRef, w.deltaVWeight, w.timeRef, w.timeWeight, score(succ, d, t, w), deltaVKey(d), timeKey(t));
  }
  // par exactly: references in the quantised units score PAR_SCORE (and one unit off each way).
  for (const m of CAMPAIGN) {
    for (const o of CAMPAIGN_SITES[m.id]) {
      if (!o.offered) continue;
      for (const [d, t] of [[o.deltaV, o.time], [up(o.deltaV), o.time], [o.deltaV, up(o.time)], [down(o.deltaV), down(o.time)], [o.deltaV + 0.1, o.time + 1], [o.deltaV - 0.05, o.time - 0.5]]) {
        const w = m.scoring;
        W.add('key', 'ok', d, t, w.deltaVRef, w.deltaVWeight, w.timeRef, w.timeWeight, score(true, d, t, w), deltaVKey(d), timeKey(t));
      }
    }
  }
  const boards: Board[] = ['combined', 'delta-v', 'time'];
  const kv = [0, 1, 2, -1, 10000, 9999, NaN];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let n = 0; n < 3000; n++) {
    const pick = () => kv[Math.floor(rnd() * kv.length)];
    const a = { score: pick(), deltaV: pick(), time: pick() };
    const b = { score: pick(), deltaV: pick(), time: pick() };
    for (const bd of boards) W.add('cmp', bd, a.score, a.deltaV, a.time, b.score, b.deltaV, b.time, compareKeys(bd, a, b));
  }

  // ---- campaign-sites, allowedSites, missionForSite
  for (const m of CAMPAIGN) {
    const off = offeredSites(m.id);
    const ll = loosestLimits(m.id);
    W.add('sites', m.id, parSite(m.id), String(off.length), ...off, ll.maxDeltaV, ll.maxTime, String((allowedSites(m) ?? []).length), ...(allowedSites(m) ?? []));
    for (const s of LAUNCH_SITES) {
      const o = CAMPAIGN_SITES[m.id].find((x) => x.site === s.id);
      const sp = o?.offered ? sitePar(m.id, s.id) : null;
      const mf = missionForSite(m, s.id);
      const lim = mf.objectives.filter((x) => x.kind === 'max-delta-v' || x.kind === 'max-time').map((x) => (x as { max: number }).max);
      W.add('site', s.id, sp ? 'par' : 'nopar', sp ? [sp.deltaVRef, sp.deltaVWeight, sp.timeRef, sp.timeWeight] : [], String(lim.length), lim);
    }
    W.add('scoring', m.scoring.deltaVRef, m.scoring.deltaVWeight, m.scoring.timeRef, m.scoring.timeWeight);
  }

  // ---- evaluations over the replay corpus
  const evalRec = (m: MissionDefinition, r: ReplayResult, epoch: number, plan?: MissionPlan) => {
    W.add('eval', mref(m), plan ? 'plan' : 'noplan', epoch);
    const e = evaluate(m, r, world, epoch, plan);
    W.add('evres', e.success ? 1 : 0, e.deltaV, e.ascentDeltaV, e.flightDeltaV, e.missionTime, e.score, e.keys ? 'keys' : 'nokeys', e.keys ? [e.keys.score, e.keys.deltaV, e.keys.time] : [],
      e.site === undefined ? '-' : e.site, String(e.objectives.length), e.ruleViolations ? String(e.ruleViolations.length) : '-');
    for (const o of e.objectives) W.add('obj', o.objective.kind, o.ok ? 1 : 0, o.at ?? NaN, 'max' in o.objective ? o.objective.max : NaN, hex(o.detail));
    for (const v of e.ruleViolations ?? []) W.add('viol', hex(v));
  };
  const probes = (r: ReplayResult, plan: MissionPlan): MissionDefinition[] => {
    const out: MissionDefinition[] = [];
    const bodies = [...new Set(r.events.map((e) => e.body))].slice(0, 3);
    const goals: Objective[] = [];
    for (const body of bodies) {
      const ps = r.events.filter((e) => e.body === body && e.kind === 'periapsis');
      const as = r.events.filter((e) => e.body === body && e.kind === 'apoapsis');
      goals.push({ kind: 'flyby', body });
      if (ps.length > 0) {
        const e0 = ps[0];
        const emin = ps.reduce((a, b) => (b.altitude < a.altitude ? b : a));
        goals.push(
          { kind: 'flyby', body, minAltitude: emin.altitude, maxAltitude: emin.altitude },
          { kind: 'flyby', body, minAltitude: up(emin.altitude) },
          { kind: 'flyby', body, maxAltitude: down(emin.altitude) },
          { kind: 'flyby', body, minAltitude: e0.altitude, maxAltitude: e0.altitude, maxSpeed: e0.speed },
          { kind: 'flyby', body, minAltitude: e0.altitude, maxAltitude: e0.altitude, maxSpeed: down(e0.speed) },
          { kind: 'visit', body, within: emin.distance },
          { kind: 'visit', body, within: down(emin.distance) },
          { kind: 'return', body, maxAltitude: emin.altitude },
          { kind: 'return', body, maxAltitude: down(emin.altitude) },
          { kind: 'sequence', steps: [{ kind: 'visit', body, within: 1e300 }, { kind: 'visit', body, within: 1e300 }, { kind: 'flyby', body }] },
        );
        if (ps.length > 1) goals.push({ kind: 'sequence', steps: [{ kind: 'flyby', body, minAltitude: ps[1].altitude, maxAltitude: ps[1].altitude }, { kind: 'visit', body, within: ps[0].distance }] });
      }
      const all = [...ps, ...as];
      if (ps.length > 0 && as.length > 0) {
        const lo = (a: typeof ps) => a.reduce((x, e) => Math.min(x, e.distance), Infinity);
        const hi = (a: typeof ps) => a.reduce((x, e) => Math.max(x, e.distance), -Infinity);
        const P: [number, number] = [lo(ps), hi(ps)];
        const A: [number, number] = [lo(as), hi(as)];
        for (const rev of [0.5, 1, 3, 1000]) goals.push({ kind: 'orbit', body, periapsis: P, apoapsis: A, revolutions: rev });
        goals.push(
          { kind: 'orbit', body, periapsis: P, apoapsis: A, inclination: [0, 180], revolutions: 1 },
          { kind: 'orbit', body, periapsis: P, apoapsis: A, inclination: [0, 90], reference: 'equator', revolutions: 1 },
          { kind: 'orbit', body, periapsis: P, apoapsis: A, inclination: [90, 180], revolutions: 1 },
          { kind: 'orbit', body, periapsis: P, apoapsis: A, inclination: [20, 70], reference: 'frame', revolutions: 2 },
          { kind: 'orbit', body, periapsis: P, apoapsis: A, inclination: [25, 35], revolutions: 2 },
          { kind: 'orbit', body, periapsis: [P[0], down(P[1])], apoapsis: A, revolutions: 2 },
          { kind: 'orbit', body, periapsis: P, apoapsis: [up(A[0]), A[1]], revolutions: 1 },
        );
      } else if (all.length > 0) goals.push({ kind: 'orbit', body, periapsis: [0, 1e300], apoapsis: [0, 1e300], revolutions: 1 });
      const last = r.events[r.events.length - 1];
      goals.push({ kind: 'reentry', body });
      if (last && last.body === body) goals.push({ kind: 'reentry', body, maxSpeed: last.speed }, { kind: 'reentry', body, maxSpeed: down(last.speed) });
    }
    for (const body of ['earth', 'moon', 'sun']) {
      goals.push({ kind: 'escape', body, minSpeed: 0 }, { kind: 'escape', body, minSpeed: 3000 });
      if (r.outcome === 'completed') {
        const k = bodyIndexOf(world, body);
        const bs = new Float64Array(6);
        world.ephemeris.bodyState(k, r.finalT, bs);
        let r2 = 0;
        let v2 = 0;
        for (let j = 0; j < 3; j++) {
          r2 += (r.finalState[j] - bs[j]) * (r.finalState[j] - bs[j]);
          v2 += (r.finalState[j + 3] - bs[j + 3]) * (r.finalState[j + 3] - bs[j + 3]);
        }
        const vinf2 = v2 - (2 * world.ephemeris.gm[k]) / Math.sqrt(r2);
        if (vinf2 > 0) goals.push({ kind: 'escape', body, minSpeed: Math.sqrt(vinf2) }, { kind: 'escape', body, minSpeed: up(Math.sqrt(vinf2)) });
      }
    }
    goals.push({ kind: 'flyby', body: 'vulcan' }, { kind: 'orbit', body: 'vulcan', periapsis: [0, 1], apoapsis: [0, 1], revolutions: 1 }, { kind: 'sequence', steps: [] });
    const sc = { deltaVRef: 1000, deltaVWeight: 1, timeRef: 86400, timeWeight: 1 };
    out.push({ id: 'probe-goals', title: '', objectives: [...goals, { kind: 'max-delta-v', max: 1e9 }, { kind: 'max-time', max: 1e12 }], scoring: sc });
    out.push({ id: 'probe-goals-atm', title: '', objectives: goals.filter((g) => g.kind !== 'reentry' && g.kind !== 'return'), scoring: sc, atmosphereIsFailure: false });
    // Score probes: one goal that the flight meets (when it has a periapsis), limits exactly at its delta-v.
    const anyP = r.events.find((e) => e.kind === 'periapsis');
    const g: Objective[] = anyP ? [{ kind: 'visit', body: anyP.body, within: 1e300 }] : [];
    const tdv = r.totalDeltaV;
    const lastGoal = anyP ? anyP.t - plan.epoch : r.elapsed;
    out.push({ id: 'probe-par', title: '', objectives: [...g, { kind: 'max-delta-v', max: tdv }], scoring: { deltaVRef: Math.ceil(tdv * 10) / 10 || 1, deltaVWeight: 1, timeRef: Math.ceil(lastGoal) || 1, timeWeight: 1 }, atmosphereIsFailure: false });
    out.push({ id: 'probe-w', title: '', objectives: [...g, { kind: 'max-time', max: lastGoal }], scoring: { deltaVRef: 1234.5, deltaVWeight: 3, timeRef: 4321, timeWeight: 2 }, atmosphereIsFailure: false });
    out.push({ id: 'probe-tight', title: '', objectives: [...g, { kind: 'max-delta-v', max: down(tdv) }, { kind: 'max-time', max: down(lastGoal) }], scoring: sc });
    return out;
  };
  let nrep = 0;
  for (const c of replayCorpus(fp)) {
    const rec = replayRecord(c, encodePlan);
    if (!rec) continue;
    W.add(...rec);
    const r = replay(c.plan, world, c.opts);
    nrep++;
    W.add('digest', r.digest, r.outcome);
    if (c.mission) {
      evalRec(c.mission, r, c.plan.epoch, c.plan);
      evalRec(c.mission, r, c.plan.epoch);
    }
    for (const p of probes(r, c.plan)) {
      evalRec(p, r, c.plan.epoch, c.plan);
      if (p.id === 'probe-par') evalRec(p, r, c.plan.epoch - 0.25);
    }
    W.add('replayend');
  }

  // ---- conformance and the leaderboard's checkRules
  const confRec = (m: MissionDefinition, plan: MissionPlan) => {
    let s: string;
    try {
      s = encodePlan(plan);
    } catch {
      return;
    }
    const issues = checkPlanConformance(m, plan);
    const rules = checkRules(plan, m);
    W.add('conf', mref(m), s, String(issues.length), String(rules.length));
    for (const x of [...issues, ...rules]) W.add('issue', x.code, hex(x.path), hex(x.message));
  };
  // Recompute the plan format (makePlan) after a change.
  const remake = ({ format: _f, model: _m, ...rest }: MissionPlan): MissionPlan => makePlan(rest);
  /** The plan as an older mission version made it: a free delivery to the parking orbit, no stages. */
  const delivered = (base: MissionPlan): MissionPlan => {
    const st = base.start as Extract<MissionPlan['start'], { kind: 'launch' }>;
    return { ...base, start: { kind: 'launch', site: st.site, params: st.params }, lowerStages: undefined, separations: undefined, burns: base.burns.map(({ stage: _s, ...b }) => b) };
  };
  const variants = (m: CompleteMission, base: MissionPlan): MissionPlan[] => {
    const st = base.start as Extract<MissionPlan['start'], { kind: 'launch' }>;
    const withParams = (f: (p: number[]) => void) => {
      const p = [...st.params];
      f(p);
      return { ...base, start: { ...st, params: p } };
    };
    const ls = base.lowerStages ?? [];
    const V = m.rules.vehicle!;
    const out: MissionPlan[] = [base];
    for (const a of [V.altitude[0], down(V.altitude[0]), V.altitude[1], up(V.altitude[1]), -0, 0, 1e9, 50e3]) out.push(withParams((p) => { p[2] = a; }));
    out.push(withParams((p) => { p[3] = p[3] + 1; }), withParams((p) => { p[4] = up(p[4]); }), withParams((p) => { p[5] = 1; }), withParams((p) => { p.length = 3; }), withParams((p) => { p.length = 4; }));
    for (const s of LAUNCH_SITES) if (s.id !== st.site) out.push({ ...base, start: { ...st, site: s.id } });
    out.push(delivered(base)); // older version: a free delivery, no stages
    out.push({ ...delivered(base), lowerStages: ls }); // a free delivery with the vehicle's stages (not encodable: skipped)
    out.push({ ...base, start: { kind: 'launch', site: st.site, params: [...st.params.slice(0, 2), 200e3, ...st.params.slice(3)], ascent: 'direct' } as MissionPlan['start'] });
    for (const [c3, alt] of [[10e6, 200e3], [10e6, 150e3], [10e6, 1500e3], [-60e6, 180e3], [up(1e6), 220e3]]) {
      out.push({ ...base, start: { kind: 'launch', site: st.site, params: [st.params[0], st.params[1], c3, alt, 0], ascent: 'direct' } as MissionPlan['start'] });
    }
    out.push({ ...delivered(base), start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] } });
    out.push({ ...delivered(base), start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, -0] } });
    out.push({ ...base, lowerStages: ls.slice(1) }, { ...base, lowerStages: [...ls, ls[ls.length - 1]] }, { ...base, lowerStages: [] });
    out.push({ ...base, lowerStages: ls.map((x, k) => (k === 0 ? { ...x, wetMass: up(x.wetMass) } : x)) });
    out.push({ ...base, lowerStages: ls.map((x, k) => (k === ls.length - 1 ? { ...x, engines: x.engines.map((e) => ({ ...e, restartable: false })) } : x)) });
    out.push({ ...base, lowerStages: ls.map((x) => ({ ...x, engines: x.engines.map((e) => ({ ...e, restartable: false, throttleable: false })) })) });
    out.push({ ...base, lowerStages: ls.map((x) => ({ ...x, engines: [...x.engines, x.engines[0]] })) });
    const sc = base.spacecraft;
    out.push({ ...base, spacecraft: { ...sc, wetMass: sc.wetMass + 1 } }, { ...base, spacecraft: { ...sc, dryMass: -0 } });
    out.push({ ...base, spacecraft: { ...sc, engines: sc.engines.map((e) => ({ ...e, restartable: false })) } });
    out.push({ ...base, spacecraft: { ...sc, engines: sc.engines.map((e) => ({ ...e, throttleable: false, thrust: e.thrust * 2 })) } });
    out.push({ ...base, spacecraft: { ...sc, engines: sc.engines.map((e) => ({ ...e, isp: up(e.isp) })) } });
    out.push({ ...base, spacecraft: { ...sc, engines: [...sc.engines, sc.engines[0]] } });
    out.push({ ...base, duration: m.maxDuration }, { ...base, duration: up(m.maxDuration) });
    out.push({ ...base, rtol: 1e-9 }, { ...base, rtol: 1e-12 }, { ...base, rtol: down(1e-12) });
    for (const ep of [-1.6e9, 3.15e9, m.epoch, up(m.epoch)]) out.push(withParams((p) => { p[0] = ep; }), { ...withParams((p) => { p[0] = ep; }), epoch: ep });
    return out.map(remake);
  };
  // Synthetic rule variants: every rule the campaign does not use.
  const ruleVariants = (m: CompleteMission): MissionDefinition[] => {
    const V = m.rules.vehicle!;
    const { vehicle: _v, ...noVehicle } = m.rules;
    const { launchSites: _l, ...noSites } = m;
    return [
      { ...m, id: 'syn-direct', rules: { ...m.rules, launchModes: ['direct'] } },
      { ...m, id: 'syn-both', rules: { ...m.rules, launchModes: ['parking-orbit', 'direct'], vehicle: { ...V, direct: { injectionAltitude: [180e3, 220e3], c3: [-60e6, 1e6] } } } },
      { ...m, id: 'syn-direct-alt', rules: { ...m.rules, launchModes: ['direct'], vehicle: { ...V, direct: { c3: [0, 20e6] } } } },
      { ...m, id: 'syn-solid', rules: { ...m.rules, nonRestartableVehicle: true } },
      { ...m, id: 'syn-fixed', rules: { ...noVehicle, launch: { kind: 'fixed', altitudeM: 200e3, ascentTimeS: 600, downrangeDeg: 20, circularization: 'j2-mean' }, altitude: [150e3, 250e3] } },
      { ...m, id: 'syn-fixed2', rules: { ...noVehicle, launch: { kind: 'fixed', altitudeM: 1.5e5, ascentTimeS: 480.5, downrangeDeg: 12.25, circularization: 'two-body' } }, start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] } },
      { ...m, id: 'syn-state', start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] }, rules: { window: [m.epoch - 86400, m.epoch + 86400] } },
      { ...m, id: 'syn-state2', start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] }, rules: {} },
      { ...noSites, id: 'syn-nosites', rules: { ...m.rules, sites: ['kourou', 'cape-canaveral'], window: [m.epoch, m.epoch + 30 * 86400] } },
      { ...m, id: 'syn-sitesub', rules: { ...m.rules, sites: ['equator', 'kourou'] } },
      { ...noSites, id: 'syn-bare', spacecraft: undefined, rules: undefined, start: undefined, maxDuration: undefined } as unknown as MissionDefinition,
      { ...noSites, id: 'syn-bare-sc', rules: undefined, start: undefined, maxDuration: undefined, objectives: [{ kind: 'max-time', max: 5e6 }] } as unknown as MissionDefinition,
    ];
  };
  for (const m of CAMPAIGN) {
    const site = m.start.kind === 'launch' ? m.start.site : '';
    const base = solutionPlan(m, site, fp);
    for (const p of variants(m, base)) confRec(m, p);
    for (const sm of ruleVariants(m)) for (const p of variants(m, base).slice(0, 40)) confRec(sm, p);
    // Plans of the other missions against this one.
    for (const o of CAMPAIGN) if (o !== m) confRec(m, solutionPlan(o, o.start.kind === 'launch' ? o.start.site : '', fp));
  }

  // ---- the leaderboard's verdicts (engine.ts + service.ts submit order)
  const engine = createEngine({ checkpoints: new Uint8Array(readFileSync(new URL('../../src/physics/data/checkpoints-1950-2100.bin', import.meta.url))) });
  const verifyRec = (planStr: string, id: string, version: string, site: string | null) => {
    W.add('verify', hex(planStr), hex(id), hex(version), site ?? '-');
    const rej = (code: string, msg: string) => W.add('rejected', code, hex(msg), 'noflight');
    const m = engine.mission(id);
    if (!m) return rej('unknown-mission', `no mission "${id.slice(0, 40)}"`);
    if (m.version !== version) return rej('mission-version', `mission "${id}" is now version ${m.version}; your plan was made for version ${version.slice(0, 32)}. Reload to get the current mission.`);
    let plan: MissionPlan;
    try {
      plan = engine.decode(planStr);
    } catch (e) {
      if (e instanceof PlanError) return rej('invalid-plan', e.message);
      throw e;
    }
    if (plan.model !== engine.model || plan.data !== engine.fingerprint) {
      return rej('version-mismatch', `this plan was made for ${plan.model < engine.model ? 'an older' : plan.model > engine.model ? 'a newer' : 'a different'} version of the game (physics model ${plan.model} / data ${plan.data}); the leaderboard runs model ${engine.model} / data ${engine.fingerprint}. Reload the game and fly it again.`);
    }
    const issues = engine.checkRules(plan, m);
    if (issues.length > 0) return rej('rule-violation', issues.map((x) => x.message).join('; '));
    const ps = plan.start.kind === 'launch' ? plan.start.site : 'state';
    if (site !== null && site !== ps) return rej('site-mismatch', `the plan launches from ${ps}, not ${site}`);
    const v = engine.verify(plan, m, { deadline: Date.now() + 1e9, maxSteps: 100_000 });
    if (v.status === 'timeout') throw new Error('timeout');
    if (v.status === 'limit') return rej('replay-limit', `the flight is too expensive to verify: ${v.reason}`);
    if (v.status === 'invalid') return rej('invalid-plan', v.reason);
    if (v.status === 'error') return rej('invalid-plan', `the physics refused this plan: ${v.reason}`);
    const objs = v.objectives;
    if (!v.success) {
      W.add('rejected', 'objectives-not-met', hex('the flight does not complete the mission'), 'flight', v.outcome, hex(v.reason), v.digest, String(objs.length));
    } else {
      W.add('accepted', v.score, v.deltaV, v.missionTime, v.digest, ps, v.steps, String(objs.length));
    }
    for (const o of objs) W.add('vobj', o.kind, o.ok ? 1 : 0, hex(o.detail));
  };
  // Plans the encoder refuses (assertValidPlan) cannot be submitted: skipped.
  const verifyEnc = (p: MissionPlan, id: string, version: string, site: string | null) => {
    let s: string;
    try {
      s = encodePlan(p);
    } catch {
      return;
    }
    verifyRec(s, id, version, site);
  };
  let nverify = 0;
  for (const m of CAMPAIGN) {
    const ver = String(m.version);
    for (const site of Object.keys(SOLUTIONS[m.id] ?? {})) {
      const base = solutionPlan(m, site, fp);
      const s = encodePlan(base);
      verifyRec(s, m.id, ver, site);
      nverify++;
      if (site !== (m.start.kind === 'launch' ? m.start.site : '')) continue;
      verifyRec(s, m.id, ver, null);
      verifyRec(s, m.id, String(m.version - 1), null);
      verifyRec(s, m.id, `${ver}.0`, null);
      verifyRec(s, m.id + 'x', ver, null);
      verifyRec(s, m.id, ver, 'vandenberg');
      verifyRec(s.slice(0, -3), m.id, ver, null);
      verifyRec('not a plan', m.id, ver, null);
      verifyEnc(({ ...base, data: '00000000' }), m.id, ver, null);
      verifyEnc(({ ...base, rtol: 1e-9 }), m.id, ver, null);
      verifyEnc(({ ...base, spacecraft: { ...base.spacecraft, wetMass: base.spacecraft.wetMass + 1 } }), m.id, ver, null);
      verifyEnc(remake(delivered(base)), m.id, ver, null);
      verifyEnc(({ ...base, start: { ...(base.start as { params: number[]; site: string; kind: 'launch' }), params: [...(base.start as { params: number[] }).params.slice(0, 2), 2e6, ...(base.start as { params: number[] }).params.slice(3)] } }), m.id, ver, null);
      // Over budget: a wasteful extra burn after the last (when it fits the duration).
      const lastB = base.burns[base.burns.length - 1];
      const extra = { ...lastB, start: lastB.start + lastB.duration + 600, duration: 30, direction: [0, 0, 1] as [number, number, number] };
      if (extra.start + 30 < base.duration) {
        verifyEnc(makePlan({ ...base, burns: [...base.burns, extra] }), m.id, ver, null);
      }
      // The plan of another mission.
      const o = CAMPAIGN[(CAMPAIGN.indexOf(m) + 1) % CAMPAIGN.length];
      verifyRec(s, o.id, String(o.version), null);
      // A fresh plan (no burns).
      verifyEnc((initialMissionPlan(m, fp)), m.id, ver, null);
    }
  }
  W.add('counts', String(nrep), String(nverify));
  writeFileSync(OUT + 'objectives.txt', W.text());
}, 3_600_000);
