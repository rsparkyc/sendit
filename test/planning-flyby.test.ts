import { beforeAll, describe, expect, it } from 'vitest';
import { ChebyshevEphemeris } from '../src/physics/chebyshev-ephemeris';
import { J2000_BODIES } from '../src/physics/solar-system';
import { tdbToIso, utcToTdb } from '../src/planning/bodies';
import { evaluateChain, optimizeChain } from '../src/planning/flyby';

const DAY = 86400;
const DEG = 180 / Math.PI;
let ephem: ChebyshevEphemeris;

// Mariner 10 (NASA NSSDCA 1973-085A): launch 1973-11-03 17:45 UTC, Venus flyby
// 1974-02-05 (closest approach 5768 km altitude), first Mercury encounter
// 1974-03-29 20:47 UTC.
const M10 = ['earth', 'venus', 'mercury'];
const M10_TIMES = [utcToTdb(1973, 11, 3 + 17.75 / 24), utcToTdb(1974, 2, 5 + 17 / 24), utcToTdb(1974, 3, 29 + 20.8 / 24)];

beforeAll(() => {
  ephem = new ChebyshevEphemeris();
  ephem.ensure(utcToTdb(1973, 1, 1), 0);
}, 600000);

describe('flyby chain', () => {
  it('Mariner 10 Earth-Venus-Mercury at the flown dates is a near-ballistic Venus flyby at roughly the flown altitude', () => {
    const r = evaluateChain(ephem, J2000_BODIES, M10, M10_TIMES);
    const v = r.flybys[0];
    console.log(`Mariner 10: C3 ${(r.c3 / 1e6).toFixed(2)} km2/s2; Venus vinf in ${(v.vInfInMag / 1e3).toFixed(3)} out ${(v.vInfOutMag / 1e3).toFixed(3)} km/s, mismatch ${v.mismatch.toFixed(0)} m/s, turn ${(v.turnAngle * DEG).toFixed(2)} deg, ballistic periapsis alt ${((v.rpBallistic - v.radius) / 1e3).toFixed(0)} km (flown: 5768 km), powered alt ${((v.rpPowered - v.radius) / 1e3).toFixed(0)} km, periapsis dv ${v.periapsisDv.toFixed(0)} m/s`);
    expect(r.ok).toBe(true);
    expect(Math.abs(v.mismatch)).toBeLessThan(300);
    expect(v.ballisticBelowMin).toBe(false);
    // Centre-to-centre Lambert legs ignore the flyby's own duration; allow a generous band.
    expect(v.rpBallistic - v.radius).toBeGreaterThan(2000e3);
    expect(v.rpBallistic - v.radius).toBeLessThan(12000e3);
  }, 60000);

  it('flags a turn that would need a periapsis below the surface', () => {
    // Venus 30 days after launch: hopeless geometry.
    const r = evaluateChain(ephem, J2000_BODIES, M10, [M10_TIMES[0], M10_TIMES[0] + 30 * DAY, M10_TIMES[2]]);
    const v = r.flybys[0];
    expect(v.ballisticBelowSurface || Math.abs(v.mismatch) > 3000).toBe(true);
  });

  it('date search recovers the Mariner 10 dates and is deterministic', () => {
    const windows = M10_TIMES.map((t) => ({ start: t - 30 * DAY, end: t + 30 * DAY }));
    const t0 = performance.now();
    const a = optimizeChain(ephem, J2000_BODIES, M10, { windows, samples: 2000 });
    const ms = performance.now() - t0;
    const b = optimizeChain(ephem, J2000_BODIES, M10, { windows, samples: 2000 });
    expect(b.times).toEqual(a.times);
    const atFlown = evaluateChain(ephem, J2000_BODIES, M10, M10_TIMES);
    console.log(`search: ${a.evaluations} evaluations in ${ms.toFixed(0)} ms; cost ${(a.result.cost / 1e3).toFixed(3)} km/s (at flown dates ${(atFlown.cost / 1e3).toFixed(3)}); dates ${a.times.map((t) => tdbToIso(t).slice(0, 10)).join(', ')}; offsets from flown ${a.times.map((t, i) => ((t - M10_TIMES[i]) / DAY).toFixed(1)).join(', ')} d`);
    expect(a.result.cost).toBeLessThanOrEqual(atFlown.cost + 1);
    // Mariner 10's launch was not minimum-energy, so only expect the same neighbourhood.
    for (let i = 0; i < 3; i++) expect(Math.abs(a.times[i] - M10_TIMES[i]) / DAY).toBeLessThan(30);
    expect(Math.abs(a.result.flybys[0].mismatch)).toBeLessThan(100);
  }, 120000);
});
