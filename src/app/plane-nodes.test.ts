import { describe, expect, it } from 'vitest';
import { crossingsNear, groupCrossings, planeCrossings, type RelSample } from './plane-nodes';

const MU = 3.986004418e14;
const DEG = Math.PI / 180;

/** Kepler orbit state at time t (periapsis at t = 0), in the reference frame. */
function kepler(a: number, e: number, i: number, raan: number, argp: number) {
  const n = Math.sqrt(MU / a ** 3);
  const p = a * (1 - e * e);
  const rot = (x: number, y: number): [number, number, number] => {
    const co = Math.cos(raan), so = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i);
    return [
      (co * cw - so * sw * ci) * x + (-co * sw - so * cw * ci) * y,
      (so * cw + co * sw * ci) * x + (-so * sw + co * cw * ci) * y,
      sw * si * x + cw * si * y,
    ];
  };
  const state = (t: number): number[] => {
    const M = n * t;
    let E = M;
    for (let k = 0; k < 50; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const r = p / (1 + e * Math.cos(nu));
    const vr = Math.sqrt(MU / p) * e * Math.sin(nu);
    const vt = Math.sqrt(MU / p) * (1 + e * Math.cos(nu));
    const pos = rot(r * Math.cos(nu), r * Math.sin(nu));
    const vel = rot(vr * Math.cos(nu) - vt * Math.sin(nu), vr * Math.sin(nu) + vt * Math.cos(nu));
    return [...pos, ...vel];
  };
  /** Time after periapsis at true anomaly nu (in [0, 2 pi)). */
  const timeAt = (nu: number): number => {
    nu = ((nu % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const Ep = (E + 2 * Math.PI) % (2 * Math.PI);
    return (Ep - e * Math.sin(Ep)) / n;
  };
  return { state, timeAt, period: (2 * Math.PI) / n, p };
}

function sample(state: (t: number) => number[], t1: number, dt: number, normal: number[], t0 = 0): RelSample[] {
  const out: RelSample[] = [];
  for (let t = t0; t <= t1; t += dt) out.push({ t, s: state(t), n: normal });
  return out;
}

describe('planeCrossings', () => {
  it('finds the nodes of an inclined eccentric orbit at their analytic times and positions', () => {
    const o = kepler(12_000e3, 0.3, 28.5 * DEG, 40 * DEG, 70 * DEG);
    const xs = planeCrossings(sample(o.state, 2 * o.period, 120, [0, 0, 1]));
    expect(xs.length).toBe(4);
    const tAN = o.timeAt(-70 * DEG);
    const tDN = o.timeAt(Math.PI - 70 * DEG);
    const asc = xs.filter((x) => x.ascending);
    const desc = xs.filter((x) => !x.ascending);
    expect(asc.length).toBe(2);
    expect(Math.abs(asc[0].t - tAN)).toBeLessThan(0.05);
    expect(Math.abs(asc[1].t - tAN - o.period)).toBeLessThan(0.05);
    expect(Math.abs(desc[0].t - tDN)).toBeLessThan(0.05);
    for (const x of xs) expect(x.inclinationDeg).toBeCloseTo(28.5, 3);
    // AN lies on the line of nodes, direction (cos raan, sin raan, 0), at r = p / (1 + e cos nu).
    const rAN = o.p / (1 + 0.3 * Math.cos(-70 * DEG));
    expect(asc[0].r[0]).toBeCloseTo(rAN * Math.cos(40 * DEG), -1);
    expect(asc[0].r[1]).toBeCloseTo(rAN * Math.sin(40 * DEG), -1);
    expect(Math.abs(asc[0].r[2])).toBeLessThan(10);
  });

  it('measures inclination relative to a tilted plane (another body\'s orbital plane)', () => {
    // Orbit at 28.5 deg to the xy plane with node along x; reference plane: 5 deg tilt about x (same node line).
    const o = kepler(7_000e3, 0, 28.5 * DEG, 0, 0);
    const n = [0, -Math.sin(5 * DEG), Math.cos(5 * DEG)];
    const xs = planeCrossings(sample(o.state, o.period * 0.75, 60, n, -37));
    expect(xs.length).toBe(2);
    for (const x of xs) expect(x.inclinationDeg).toBeCloseTo(23.5, 3);
    expect(xs[0].ascending).toBe(true);
    expect(Math.abs(xs[0].t)).toBeLessThan(1e-6 + 0.05); // at t = 0 (node on the x axis)
    expect(Math.abs(xs[1].t - o.period / 2)).toBeLessThan(0.05);
  });

  it('a retrograde orbit has inclination above 90 deg', () => {
    const o = kepler(7_000e3, 0.01, 150 * DEG, 10 * DEG, 0);
    const xs = planeCrossings(sample(o.state, o.period * 1.5, 60, [0, 0, 1]));
    expect(xs.length).toBeGreaterThanOrEqual(2);
    for (const x of xs) expect(x.inclinationDeg).toBeCloseTo(150, 3);
  });
});

describe('crossingsNear / groupCrossings', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ t: i * 100, ascending: i % 2 === 0, inclinationDeg: 28.5, r: [0, 0, 0] as [number, number, number] }));
  it('marks only the crossings around the cursor when there are many', () => {
    expect(crossingsNear(many, 1050)).toEqual([11, 12]);
    expect(crossingsNear(many, 9999)).toEqual([38, 39]);
    expect(crossingsNear(many, -5)).toEqual([0, 1]);
    expect(crossingsNear(many.slice(0, 4), 1050)).toEqual([0, 1, 2, 3]);
  });
  it('groups a long run of equal-inclination crossings', () => {
    const g = groupCrossings([...many.slice(0, 2).map((c) => ({ ...c, inclinationDeg: 5 })), ...many.slice(2)]);
    expect(g[0]).toEqual([0]);
    expect(g[1]).toEqual([1]);
    expect(g[2].length).toBe(38);
  });
});
