import { describe, expect, it } from 'vitest';
import { makePlan, PHYSICS_MODEL, validatePlan, type MissionPlan } from './mission-layer';
import { addNode, budget, burnToNode, disableNode, elementsFromState, enableNode, G0, nodesOf, nodeToBurn, removeNode, setSpacecraft, stateFromElements, updateNode, type ManeuverNode } from './nodes';

const craft = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }, { thrust: 2000, isp: 300 }] };
const base: MissionPlan = makePlan({ data: '01234567', epoch: 0, duration: 86400, rtol: 1e-10, start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] }, spacecraft: craft, burns: [] });
const node = (t: number, dv: [number, number, number], engine = 0): ManeuverNode => ({ t, dv, frame: { kind: 'orbital', body: 'earth' }, engine });

describe('node <-> burn', () => {
  it('uses the rocket equation with the mass at ignition, centred on the node time', () => {
    const b = nodeToBurn(node(1000, [3000, 0, 0]), craft, 30000);
    const ve = 450 * G0;
    const mf = 30000 * Math.exp(-3000 / ve);
    expect(b.duration).toBeCloseTo(((30000 - mf) * ve) / 200e3, 9);
    expect(b.start + b.duration / 2).toBeCloseTo(1000, 9);
    expect(b.direction).toEqual([1, 0, 0]);
    expect(b.frame).toEqual({ kind: 'orbital', body: 'earth' });
  });

  it('round-trips a node to a few ulps', () => {
    for (const dv of [[0.01, 0, 0], [1234.5, -20, 3.25], [-5, 0.5, 100], [0, 0, 1e-3]] as [number, number, number][]) {
      for (const m0 of [30000, 20000, 12500]) {
        const n = node(4321.5, dv, 1);
        const back = burnToNode(nodeToBurn(n, craft, m0), craft, m0);
        expect(back.t).toBeCloseTo(n.t, 7);
        back.dv.forEach((v, k) => expect(Math.abs(v - dv[k])).toBeLessThan(1e-9 * Math.max(1, Math.hypot(...dv))));
        expect(back.engine).toBe(1);
      }
    }
  });

  it('a zero delta-v node becomes a burn the plan layer rejects (shown as an error on that node)', () => {
    const p = addNode(base, node(100, [0, 0, 0])).plan;
    expect(validatePlan(p).some((e) => e.includes('burns[0]'))).toBe(true);
  });
});

describe('plan editing', () => {
  it('keeps nodes sorted by time and tracks the edited node', () => {
    let p = addNode(base, node(5000, [100, 0, 0])).plan;
    const r = addNode(p, node(1000, [50, 0, 0]));
    expect(r.index).toBe(0);
    p = r.plan;
    expect(nodesOf(p).map((x) => Math.round(x.node.t))).toEqual([1000, 5000]);
    const moved = updateNode(p, 0, { t: 9000 });
    expect(moved.index).toBe(1);
    expect(nodesOf(moved.plan).map((x) => Math.round(x.node.t))).toEqual([5000, 9000]);
    expect(validatePlan(moved.plan)).toEqual([]);
  });

  it('editing a node keeps earlier burns bit-identical and later nodes’ requested delta-v', () => {
    let p = addNode(base, node(1000, [500, 0, 0])).plan;
    p = addNode(p, node(5000, [200, 10, 0])).plan;
    p = addNode(p, node(9000, [300, 0, 0])).plan;
    const before = nodesOf(p);
    const q = updateNode(p, 1, { dv: [400, 10, 0] }).plan;
    expect(q.burns[0]).toBe(p.burns[0]);
    const after = nodesOf(q);
    expect(after[2].node.dv[0]).toBeCloseTo(before[2].node.dv[0], 9);
    expect(after[2].burn.duration).toBeLessThan(before[2].burn.duration); // lighter craft, same delta-v, shorter burn
    expect(after[1].node.dv[0]).toBeCloseTo(400, 9);
  });

  it('overlapping burns are plan errors on the later burn', () => {
    let p = addNode(base, node(1000, [3000, 0, 0])).plan; // ~ 200 s burn
    p = addNode(p, node(1050, [10, 0, 0])).plan;
    expect(validatePlan(p).some((e) => /burns\[1\] starts before the previous burn ends/.test(e))).toBe(true);
  });

  it('disable / enable / delete', () => {
    let p = addNode(base, node(1000, [500, 0, 0])).plan;
    p = addNode(p, node(5000, [200, 0, 0])).plan;
    const d = disableNode(p, 0);
    expect(d.plan.burns.length).toBe(1);
    expect(nodesOf(d.plan)[0].node.dv[0]).toBeCloseTo(200, 9);
    const e = enableNode(d.plan, d.parked);
    expect(e.index).toBe(0);
    expect(nodesOf(e.plan).map((x) => x.node.dv[0].toFixed(6))).toEqual(['500.000000', '200.000000']);
    expect(removeNode(e.plan, 1).burns.length).toBe(1);
  });

  it('changing the spacecraft keeps requested delta-v and remaps missing engines', () => {
    let p = addNode(base, node(1000, [500, 0, 0], 1)).plan;
    p = setSpacecraft(p, { wetMass: 40000, dryMass: 10000, engines: [{ thrust: 100e3, isp: 320 }] });
    const n = nodesOf(p)[0];
    expect(n.node.engine).toBe(0);
    expect(n.node.dv[0]).toBeCloseTo(500, 9);
    expect(n.m0).toBe(40000);
  });

  it('budget: total, requested, remaining, and a burn larger than the tanks is flagged short', () => {
    const p = addNode(base, node(1000, [1000, 0, 0])).plan;
    const b = budget(p);
    expect(b.total).toBeCloseTo(450 * G0 * Math.log(30000 / 12000), 6);
    expect(b.requested).toBeCloseTo(1000, 9);
    expect(b.remaining).toBeCloseTo(b.total - 1000, 6);
    const big = addNode(base, node(1000, [9000, 0, 0])).plan;
    expect(nodesOf(big)[0].short).toBe(true);
  });

  it('plans built by the editor carry the current physics model', () => {
    expect(base.model).toBe(PHYSICS_MODEL);
  });
});

describe('orbit elements for free starts', () => {
  it('round-trips periapsis, apoapsis and inclination', () => {
    const mu = 3.986004418e14;
    const R = 6371e3;
    const pole = [0.1, -0.05, 0.99];
    const s = stateFromElements(mu, R, pole, { periAlt: 300e3, apoAlt: 35786e3, incDeg: 27, raanDeg: 40, argPeDeg: 180, trueAnomalyDeg: 33 });
    const e = elementsFromState(mu, R, pole, s);
    expect(e.periAlt).toBeCloseTo(300e3, 0);
    expect(e.apoAlt).toBeCloseTo(35786e3, -1);
    expect(e.incDeg).toBeCloseTo(27, 9);
  });
});
