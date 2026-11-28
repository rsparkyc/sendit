/** Snapping a separation off engine burns (plan.ts snapSeparationTime), and that a snapped drop is a valid plan. */
import { describe, expect, it } from 'vitest';
import { errorCount, planErrors, simulationStartOffset, snapSeparationTime } from './mission-layer';
import { initialPlan, missionById } from './missions';
import { stagingIssues } from '../mission/plan';
import { addNode, addSeparation, moveSeparation, separationOffer } from './nodes';

const B = (start: number, duration: number) => ({ start, duration });

describe('snapSeparationTime', () => {
  const burns = [B(100, 50)]; // fires 100..150
  it('leaves a time no burn spans alone, including a burn start or cutoff exactly', () => {
    expect(snapSeparationTime(burns, 90, 0)).toBe(90);
    expect(snapSeparationTime(burns, 100, 0)).toBe(100);
    expect(snapSeparationTime(burns, 150, 0)).toBe(150);
  });
  it('inside a burn: the nearer of its start and its cutoff', () => {
    expect(snapSeparationTime(burns, 110, 0)).toBe(100);
    expect(snapSeparationTime(burns, 140, 0)).toBe(150);
    expect(snapSeparationTime(burns, 125, 0)).toBe(100); // a tie goes before
  });
  it('fractional burn edges round outward to whole seconds', () => {
    expect(snapSeparationTime([B(100.4, 10.2)], 101, 0)).toBe(100);
    expect(snapSeparationTime([B(100.4, 10.2)], 110, 0)).toBe(111);
  });
  it('passes over back-to-back and overlapping burns', () => {
    const bb = [B(100, 50), B(150.5, 20), B(160, 30)]; // 100..150, 150.5..170.5, 160..190
    expect(snapSeparationTime(bb, 155, 0)).toBe(150);
    expect(snapSeparationTime(bb, 185, 0)).toBe(190);
    expect(snapSeparationTime(bb, 151, 0)).toBe(150);
  });
  it('a side outside [lo, hi] is not offered; no valid side: stay at the fallback', () => {
    expect(snapSeparationTime(burns, 110, 7, 120)).toBe(150);
    expect(snapSeparationTime(burns, 140, 7, -Infinity, 140)).toBe(100);
    expect(snapSeparationTime(burns, 125, 7, 120, 140)).toBe(7);
    // A burn filling the whole flight.
    expect(snapSeparationTime([B(0, 1000)], 500, 42, 0, 1000)).toBe(0);
    expect(snapSeparationTime([B(0, 1000)], 500, 42, 1, 999)).toBe(42);
  });
  it('a forced side (keyboard step) skips the burn that way, or stays', () => {
    expect(snapSeparationTime(burns, 110, 0, -Infinity, Infinity, 1)).toBe(150);
    expect(snapSeparationTime(burns, 140, 0, -Infinity, Infinity, -1)).toBe(100);
    expect(snapSeparationTime(burns, 110, 99, -Infinity, 140, 1)).toBe(99);
  });
});

describe('a snapped drop is a valid plan', () => {
  it('every time inside the satellite burn snaps to a time moveSeparation accepts with no plan errors', () => {
    const earth = { kind: 'orbital' as const, body: 'earth' };
    let p = initialPlan(missionById('geo-from-leo')!, '01234567');
    p = addNode(p, { t: 2040, dv: [2497, 0, 0], frame: earth, engine: 0 }).plan;
    p = addNode(p, { t: 21000, dv: [1466, -11, 20], frame: earth, engine: 0 }).plan;
    const r = addSeparation(p, separationOffer(p, 0)!.time);
    if ('error' in r) throw new Error(r.error);
    const plan = r.plan;
    expect(errorCount(planErrors(plan))).toBe(0);
    const b = plan.burns[1];
    expect(b.duration).toBeGreaterThan(2);
    const last = plan.separations![0].time;
    const first = plan.burns[0].stage!; // the stage active when the flight starts (it fires the first burn)
    for (const f of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const raw = Math.round(b.start + f * b.duration);
      // The unsnapped drop is the error snapping avoids (unless re-staging re-planned the burn clear of it).
      const bad = moveSeparation(plan, 0, raw);
      if ('error' in bad) throw new Error(bad.error);
      const nb = bad.plan.burns[1];
      if (raw > nb.start && raw < nb.start + nb.duration) expect(stagingIssues(bad.plan, first).map((x) => x.code)).toContain('burn-spans-separation');
      const t = snapSeparationTime(plan.burns, raw, last, simulationStartOffset(plan.start), plan.duration);
      expect(t > b.start && t < b.start + b.duration).toBe(false);
      const m = moveSeparation(plan, 0, t);
      if ('error' in m) throw new Error(m.error);
      expect(errorCount(planErrors(m.plan))).toBe(0);
      expect(stagingIssues(m.plan, first)).toEqual([]);
    }
  });
});
