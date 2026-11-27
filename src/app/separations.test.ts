/** Separations as flight actions (nodes.ts), on a real campaign vehicle launch. */
import { describe, expect, it } from 'vitest';
import { planErrors, errorCount } from './mission-layer';
import { initialPlan, missionById } from './missions';
import { addNode, addSeparation, moveSeparation, nodesOf, removeSeparation, separationOffer, separationsOf, setStages, updateNode } from './nodes';
import { stagePlan, stageRows } from './vehicle';
import { planAscent } from './mission-layer';
import { BODY_DATA } from './physics';

const earth = { kind: 'orbital' as const, body: 'earth' };
const geo = () => initialPlan(missionById('geo-from-leo')!, '01234567');

describe('separations', () => {
  it('separate after a burn: later nodes move to the spacecraft, keeping their delta-v; earlier burns are untouched', () => {
    let p = addNode(geo(), { t: 2040, dv: [2497, 0, 0], frame: earth, engine: 0 }).plan;
    p = addNode(p, { t: 21000, dv: [1466, -11, 20], frame: earth, engine: 0 }).plan;
    const L = p.lowerStages!.length;
    expect(nodesOf(p).map((x) => x.stage)).toEqual([L - 1, L - 1]);
    const offer = separationOffer(p, 0)!;
    expect(offer.empty).toBe(false);
    const r = addSeparation(p, offer.time);
    if ('error' in r) throw new Error(r.error);
    expect(r.plan.burns[0]).toBe(p.burns[0]);
    expect(nodesOf(r.plan).map((x) => x.stage)).toEqual([L - 1, L]);
    expect(nodesOf(r.plan)[1].node.dv[0]).toBeCloseTo(1466, 6);
    expect(errorCount(planErrors(r.plan))).toBe(0);
    expect(separationsOf(r.plan)[0]).toMatchObject({ dropped: L - 1, next: L, empty: false });
    expect(separationOffer(r.plan, 0)).toBeNull();
    // Move it past burn 2: burn 2 goes back to the upper stage.
    const m = moveSeparation(r.plan, 0, 30000);
    if ('error' in m) throw new Error(m.error);
    expect(nodesOf(m.plan).map((x) => x.stage)).toEqual([L - 1, L - 1]);
    // Remove it: no automatic separation comes back.
    const back = removeSeparation(r.plan, 0);
    expect(back.separations ?? []).toEqual([]);
    expect(nodesOf(back).map((x) => x.stage)).toEqual([L - 1, L - 1]);
  });

  it('flags a burn spanning a separation with the plan layer reason; refuses a separation that would drop the spacecraft or precede insertion', () => {
    let p = addNode(geo(), { t: 2040, dv: [2497, 0, 0], frame: earth, engine: 0 }).plan;
    const r = addSeparation(p, 2040);
    if ('error' in r) throw new Error(r.error);
    const e = planErrors(r.plan);
    expect([...e.burns.values()].flat().join()).toMatch(/still firing at separations\[0\]|active stage/);
    expect(addSeparation(p, 10)).toHaveProperty('error');
    p = (addSeparation(p, 5000) as { plan: typeof p }).plan;
    expect(addSeparation(p, 6000)).toHaveProperty('error'); // only the upper stage is left below the spacecraft
  });

  it('a burn that empties its stage offers "separate now" as empty; the automatic separation is a visible separation', () => {
    let p = addNode(geo(), { t: 2040, dv: [20000, 0, 0], frame: earth, engine: 0 }).plan;
    expect(separationOffer(p, 0)!.empty).toBe(true);
    p = addNode(p, { t: 30000, dv: [10, 0, 0], frame: earth, engine: 0 }).plan;
    expect(separationsOf(p)).toHaveLength(1);
    expect(separationsOf(p)[0].empty).toBe(true);
    p = updateNode(p, 1, { dv: [20, 0, 0] }).plan;
    expect(separationsOf(p)).toHaveLength(1);
  });

  it('stage figures: names, per-stage delta-v with the stack above, the ascent leaving the upper stage its propellant', () => {
    const p = geo();
    const rows = stageRows(p);
    expect(rows.at(-1)!.name).toBe('Spacecraft');
    expect(rows[0].name).toMatch(/Ariane 5 ECA stage 1/);
    expect(rows.at(-2)!.name).toMatch(/upper stage/);
    for (const r of rows) expect(r.deltaV).toBeGreaterThan(0);
    const a = planAscent(p, BODY_DATA)!;
    const sp = stagePlan(p, a);
    expect(a.ok && sp[a.upperStage].atStart).toBe(a.ok && a.upperPropellant);
    expect(sp[0].ascent).toBe('dropped');
  });

  it('sandbox vehicle editor: a spacecraft alone stays format 1; adding a stage makes a vehicle launch', () => {
    const sb = initialPlan(missionById('sandbox')!, '01234567');
    expect(sb.format).toBe(1);
    const two = setStages(sb, [{ wetMass: 120000, dryMass: 9000, engines: [{ thrust: 1.8e6, isp: 330 }] }, { wetMass: 30000, dryMass: 3000, engines: [{ thrust: 3e5, isp: 345 }] }], sb.spacecraft);
    expect(two.format).toBe(2);
    expect(two.start.kind === 'launch' && two.start.ascent).toBe('vehicle');
    expect(setStages(two, null, sb.spacecraft)).toEqual(sb);
  });
});
