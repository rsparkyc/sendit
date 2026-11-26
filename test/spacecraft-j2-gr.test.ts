/**
 * Spacecraft J2 and Sun 1PN against analytic secular rates.
 */
import { describe, expect, it } from 'vitest';
import { propagate, type BodyOblateness, type Ephemeris } from '../src/physics/spacecraft';
import { J2000_BODIES, bodyIndex } from '../src/physics/solar-system';

/** Bodies fixed in space, with optional J2 and relativity. */
class StaticEphemeris implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  constructor(
    gm: number[],
    readonly oblateness?: (BodyOblateness | null)[],
    readonly relativity?: { body: number },
  ) {
    this.count = gm.length;
    this.gm = Float64Array.from(gm);
  }
  positions(_t: number, out: Float64Array): void {
    out.fill(0);
  }
  bodyState(_b: number, _t: number, out: Float64Array): void {
    out.fill(0, 0, 6);
  }
}

const earthData = J2000_BODIES[bodyIndex('earth')];
const MU = earthData.gm;
const J2 = earthData.j2!;
const RE = earthData.j2Radius!;
const DEG = Math.PI / 180;

function elements(y: ArrayLike<number>, mu: number) {
  const r = [y[0], y[1], y[2]];
  const v = [y[3], y[4], y[5]];
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const rn = Math.hypot(...r);
  const vxh = [v[1] * h[2] - v[2] * h[1], v[2] * h[0] - v[0] * h[2], v[0] * h[1] - v[1] * h[0]];
  const e = [vxh[0] / mu - r[0] / rn, vxh[1] / mu - r[1] / rn, vxh[2] / mu - r[2] / rn];
  const node = [-h[1], h[0], 0];
  const raan = Math.atan2(node[1], node[0]);
  const nn = Math.hypot(...node);
  const en = Math.hypot(...e);
  const hn = Math.hypot(...h);
  const cosw = (node[0] * e[0] + node[1] * e[1]) / (nn * en);
  const sinw = (e[2] * hn) / (nn * en); // sign of e_z with the h-direction convention
  return { raan, argp: Math.atan2(sinw, cosw), ecc: e, h };
}

/** Least-squares slope of an angle series after unwrapping. */
function slope(ts: number[], xs: number[]): number {
  const u = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    let d = xs[i] - xs[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    u.push(u[i - 1] + d);
  }
  const n = ts.length;
  const mt = ts.reduce((a, b) => a + b) / n;
  const mx = u.reduce((a, b) => a + b) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - mt) * (u[i] - mx);
    den += (ts[i] - mt) ** 2;
  }
  return num / den;
}

/** Propagate and sample RAAN and argument of perigee on a uniform grid. */
function secularRates(a: number, e: number, inc: number, days: number) {
  const eph = new StaticEphemeris([MU], [{ j2: J2, radius: RE, pole: [0, 0, 1] }]);
  const rp = a * (1 - e);
  const vp = Math.sqrt((MU * (1 + e)) / rp);
  const y0 = [rp, 0, 0, 0, vp * Math.cos(inc), vp * Math.sin(inc), 1000];
  const T = days * 86400;
  const dt = 60;
  const ts: number[] = [];
  const raan: number[] = [];
  const argp: number[] = [];
  let next = 0;
  const buf = new Float64Array(7);
  propagate(eph, y0, 0, T, [], {
    onStep: (t, _y, interp) => {
      while (next <= t) {
        interp(next, buf);
        const el = elements(buf, MU);
        ts.push(next);
        raan.push(el.raan);
        argp.push(el.argp);
        next += dt;
      }
    },
  });
  return { raanRate: slope(ts, raan), argpRate: slope(ts, argp) };
}

describe('spacecraft J2', () => {
  it('LEO nodal regression and apsidal rotation match the secular J2 theory', () => {
    const a = 7_000_000;
    const e = 0.05;
    const inc = 50 * DEG;
    const { raanRate, argpRate } = secularRates(a, e, inc, 5);
    const n = Math.sqrt(MU / a ** 3);
    const p = a * (1 - e * e);
    const k = n * J2 * (RE / p) ** 2;
    const raanTheory = -1.5 * k * Math.cos(inc);
    const argpTheory = 0.75 * k * (5 * Math.cos(inc) ** 2 - 1);
    const perDay = 86400 / DEG;
    console.log(
      `LEO a=7000 km i=50: dRAAN/dt ${(raanRate * perDay).toFixed(4)} deg/d (theory ${(raanTheory * perDay).toFixed(4)}), ` +
        `dargp/dt ${(argpRate * perDay).toFixed(4)} deg/d (theory ${(argpTheory * perDay).toFixed(4)})`,
    );
    // First-order secular theory with osculating a, e for the mean ones: agreement
    // to O(J2) ~ 0.1-1% is expected. Observed +0.44% and +0.55%.
    expect(Math.abs(raanRate / raanTheory - 1)).toBeLessThan(0.01);
    expect(Math.abs(argpRate / argpTheory - 1)).toBeLessThan(0.03);
  }, 60_000);

  it('a sun-synchronous orbit precesses 0.9856 deg/day', () => {
    const a = RE + 700_000;
    const target = (2 * Math.PI) / (365.2422 * 86400); // rad/s, one turn per tropical year
    const n = Math.sqrt(MU / a ** 3);
    const inc = Math.acos(-target / (1.5 * n * J2 * (RE / a) ** 2));
    const { raanRate } = secularRates(a, 0, inc, 5);
    const perDay = 86400 / DEG;
    console.log(`SSO 700 km, i=${(inc / DEG).toFixed(3)} deg: dRAAN/dt ${(raanRate * perDay).toFixed(4)} deg/d (target 0.9856)`);
    // Observed 0.9900 (+0.45%, the same osculating-vs-mean offset as above).
    expect(Math.abs(raanRate * perDay - 0.9856)).toBeLessThan(0.01);
  }, 60_000);
});

describe('spacecraft Sun 1PN', () => {
  it('a Mercury-like orbit precesses 6 pi mu / (c^2 a (1-e^2)) per orbit', () => {
    const sun = J2000_BODIES[bodyIndex('sun')];
    const mu = sun.gm;
    const eph = new StaticEphemeris([mu], undefined, { body: 0 });
    const a = 5.7909e10;
    const e = 0.2056;
    const rp = a * (1 - e);
    const vp = Math.sqrt((mu * (1 + e)) / rp);
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / mu);
    const orbits = 10;
    const res = propagate(eph, [rp, 0, 0, 0, vp, 0, 1], 0, orbits * period, [], { rtol: 1e-13 });
    const el = elements(res.y, mu);
    const angle = Math.atan2(el.ecc[1], el.ecc[0]);
    const theory = (orbits * 6 * Math.PI * mu) / (299792458 ** 2 * a * (1 - e * e));
    console.log(`perihelion advance over ${orbits} orbits: ${(angle * 206264.8).toFixed(4)}" (theory ${(theory * 206264.8).toFixed(4)}")`);
    // The 1PN theory value is for the mean orbit; osculating elements at the same
    // phase differ by O(mu/(c^2 a)) ~ 1e-8 relative, i.e. < 1% of the advance.
    expect(Math.abs(angle / theory - 1)).toBeLessThan(0.01);
  }, 60_000);

});
