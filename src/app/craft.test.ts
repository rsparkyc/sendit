import { describe, expect, it } from 'vitest';
import { craftPerformance, initialPlan, missionById, missionForLoadedPlan, spacecraftIssues } from './missions';

describe('mission spacecraft', () => {
  const entry = missionById('lunar-flyby')!;
  const plan = initialPlan(entry, '00000000');

  it('a fresh mission plan conforms; a changed spacecraft does not and opens as sandbox with a notice', () => {
    expect(spacecraftIssues(entry, plan)).toEqual([]);
    expect(missionForLoadedPlan('lunar-flyby', plan)).toEqual({ missionId: 'lunar-flyby', notice: null });
    const other = { ...plan, spacecraft: { ...plan.spacecraft, wetMass: plan.spacecraft.wetMass + 1 } };
    const m = missionForLoadedPlan('lunar-flyby', other);
    expect(m.missionId).toBe('sandbox');
    expect(m.notice).toMatch(/not scored/);
    expect(missionForLoadedPlan('sandbox', other).notice).toBeNull();
  });

  it('reports thrust-to-weight and rocket-equation delta-v', () => {
    const [p] = craftPerformance({ wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] });
    expect(p.twr).toBeCloseTo(200e3 / (30000 * 9.80665), 6);
    expect(p.dv).toBeCloseTo(450 * 9.80665 * Math.log(2.5), 3);
  });
});
