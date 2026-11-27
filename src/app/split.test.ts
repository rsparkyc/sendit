/** splitAcrossSeparation (nodes.ts): a burn its stage cannot complete, split so the next stage finishes it. */
import { describe, expect, it } from 'vitest';
import { errorCount, planErrors } from './mission-layer';
import { initialPlan, missionById } from './missions';
import { addNode, addSeparation, dvMagnitude, nodesOf, separationsOf, splitAcrossSeparation } from './nodes';

const earth = { kind: 'orbital' as const, body: 'earth' };
const geo = () => initialPlan(missionById('geo-from-leo')!, '01234567');

describe('splitAcrossSeparation', () => {
  it('splits a burn the upper stage cannot complete: the stage burns what it has, separates 1 s after cutoff, the next stage flies the rest in the same direction', () => {
    const dv: [number, number, number] = [3600, 120, -80];
    const p = addNode(geo(), { t: 2400, dv, frame: earth, engine: 0 }).plan;
    const L = p.lowerStages!.length;
    const x = nodesOf(p)[0];
    expect(x.stage).toBe(L - 1);
    expect(x.short).toBe(true);
    const sp = splitAcrossSeparation(p, 0)!;
    expect(sp).not.toBeNull();
    expect(sp.first).toBe(0);
    expect(sp.available).toBeGreaterThan(1000);
    expect(sp.available).toBeLessThan(dvMagnitude(dv));
    expect(sp.available + sp.rest).toBeCloseTo(dvMagnitude(dv), 6);
    const n = nodesOf(sp.plan);
    expect(n).toHaveLength(2);
    const [a, b] = [n[sp.first], n[sp.second]];
    // Same ignition, the stage's own delta-v, not short any more.
    expect(a.burn.start).toBeCloseTo(x.burn.start, 6);
    expect(dvMagnitude(a.node.dv)).toBeCloseTo(sp.available, 6);
    expect(a.short).toBe(false);
    expect(a.stage).toBe(L - 1);
    // The separation 1 s after cutoff, then the next stage.
    const seps = separationsOf(sp.plan);
    expect(seps).toHaveLength(1);
    expect(seps[0].time).toBeCloseTo(a.burn.start + a.burn.duration + 1, 6);
    expect(seps[0]).toMatchObject({ dropped: L - 1, next: L });
    expect(b.stage).toBe(L);
    expect(b.burn.start).toBeGreaterThan(seps[0].time);
    expect(dvMagnitude(b.node.dv)).toBeCloseTo(sp.rest, 6);
    // Same direction.
    for (const k of [0, 1, 2]) {
      expect(a.node.dv[k] / dvMagnitude(a.node.dv)).toBeCloseTo(dv[k] / dvMagnitude(dv), 9);
      expect(b.node.dv[k] / dvMagnitude(b.node.dv)).toBeCloseTo(dv[k] / dvMagnitude(dv), 9);
    }
    expect(errorCount(planErrors(sp.plan))).toBe(0);
  });

  it('returns null when the burn is not short, or is already on the last stage', () => {
    const ok = addNode(geo(), { t: 2400, dv: [1000, 0, 0], frame: earth, engine: 0 }).plan;
    expect(splitAcrossSeparation(ok, 0)).toBeNull();
    // On the spacecraft (after a separation) there is no next stage.
    let p = addNode(geo(), { t: 2400, dv: [1000, 0, 0], frame: earth, engine: 0 }).plan;
    p = (addSeparation(p, 5000) as { plan: typeof p }).plan;
    p = addNode(p, { t: 20000, dv: [50000, 0, 0], frame: earth, engine: 0 }).plan;
    expect(nodesOf(p)[1].short).toBe(true);
    expect(splitAcrossSeparation(p, 1)).toBeNull();
    expect(splitAcrossSeparation(p, 7)).toBeNull();
  });
});
