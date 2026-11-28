/**
 * Ascent vectors (core/fixtures/generated/ascent.txt) for core/src/mission/ascent.rs.
 *
 * computeAscent and computeDirectAscent, every output (refusal reason, or the
 * upper stage, propellant, mass, delta-v, losses, kick, liftoff T/W, per-stage
 * accounting, direct burnout), for every catalogue vehicle and the solid
 * vehicle x launch site x azimuths across the corridor x parking altitudes
 * (band limits, below and above the powered insertion altitude, 0, NaN) and
 * direct-injection C3 / altitude grids, with light and heavy spacecraft (so
 * some launches are refused for each reason), spacecraft and stage
 * propulsion flags, synthetic geometries and the Moon's airless constants.
 * The geometry is launchGeometry's (proven in launch.txt) and is recorded.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { Lines } from './shared';
import { ASCENT_BODIES, computeAscent, computeDirectAscent, type AscentBody, type AscentGeometry } from '../../src/mission/ascent';
import { LAUNCH_SITES, launchGeometry } from '../../src/mission/launch';
import { VEHICLES, SOLID_VEHICLES, PARKING_BAND } from '../../src/mission/vehicles';
import { J2000_BODIES } from '../../src/physics/solar-system';
import type { Engine, Stage } from '../../src/mission/plan';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';
const YEAR = 365.25 * 86400;

let rng = 0x1234567;
const rand = () => {
  rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
  rng ^= rng >>> 13;
  return (rng >>> 0) / 4294967296;
};
const flag = (b: boolean | undefined) => (b === undefined ? 0 : b ? 2 : 1);
const stagesRec = (st: readonly Stage[]): number[] =>
  [st.length, ...st.flatMap((s) => [s.wetMass, s.dryMass, s.engines.length, ...s.engines.flatMap((e) => [e.thrust, e.isp, flag(e.restartable), flag(e.throttleable)])])];
const usesRec = (u: readonly { stage: number; propellantUsed: number; propellantLeft: number; deltaV: number; time: number; separated: boolean }[]) =>
  [u.length, ...u.flatMap((x) => [x.stage, x.propellantUsed, x.propellantLeft, x.deltaV, x.time, x.separated ? 1 : 0])];

it('export ascent vectors', () => {
  const W = new Lines();
  const earth = J2000_BODIES.find((b) => b.id === 'earth')!;
  const moon = J2000_BODIES.find((b) => b.id === 'moon')!;
  const craft: Stage[] = [
    { wetMass: 2000, dryMass: 600, engines: [{ thrust: 4000, isp: 320 }] },
    { wetMass: 15000, dryMass: 3000, engines: [{ thrust: 30000, isp: 330 }] },
    { wetMass: 400, dryMass: 100, engines: [{ thrust: 400, isp: 300, restartable: false }] },
    { wetMass: 120000, dryMass: 20000, engines: [{ thrust: 1e5, isp: 320 }] },
  ];
  const vehicles: { id: string; stages: readonly Stage[] }[] = [...VEHICLES, ...SOLID_VEHICLES].map((v) => ({ id: v.id, stages: v.stages }));
  // Flag variants of catalogue vehicles: a solid upper stage (cannot shut down), a non-restartable upper.
  const f9 = VEHICLES[0].stages;
  const withFlags = (s: Stage, e: Partial<Engine>): Stage => ({ ...s, engines: s.engines.map((x) => ({ ...x, ...e })) });
  vehicles.push({ id: 'f9-solid-upper', stages: [f9[0], withFlags(f9[1], { throttleable: false })] });
  vehicles.push({ id: 'f9-norestart-upper', stages: [f9[0], withFlags(f9[1], { restartable: false })] });
  vehicles.push({ id: 'f9-true-flags', stages: [withFlags(f9[0], { restartable: true, throttleable: true }), f9[1]] });
  vehicles.push({ id: 'weak', stages: [{ wetMass: 50000, dryMass: 5000, engines: [{ thrust: 5e5, isp: 300 }] }] });
  vehicles.push({ id: 'hot', stages: [{ wetMass: 210000, dryMass: 10000, engines: [{ thrust: 2.5e7, isp: 300 }] }, { wetMass: 53000, dryMass: 3000, engines: [{ thrust: 6e6, isp: 340 }] }] });
  vehicles.push({ id: 'single-stage', stages: [{ wetMass: 300000, dryMass: 20000, engines: [{ thrust: 5e6, isp: 330 }, { thrust: 1e6, isp: 340 }] }] });

  const alts = [PARKING_BAND[0], PARKING_BAND[1], 185e3, 185e3 - 1, 185e3 + 1, 250e3, 600e3, 2000e3, 50e3, 0, -1, NaN];
  const c3s = [-60e6, -2e6, -1e6, 0, 1e6, 10e6, 30e6, 80e6];
  const hIs = [150e3, 185e3, 250e3, 400e3, 0, NaN];
  const body = (b: AscentBody) => (b.id === 'earth' ? earth : moon);

  const one = (vid: string, stack: Stage[], geom: AscentGeometry, b: AscentBody, alt: number, tag: string) => {
    const B = body(b);
    const head = ['asc', vid, b.id, tag, B.gm, B.referenceRadius, alt, geom.alongTrack, geom.crossTrack, ...stagesRec(stack)] as const;
    try {
      const r = computeAscent(stack, { gm: B.gm, radius: B.referenceRadius, altitudeM: alt }, geom, b);
      if (!r.ok) W.add(...head, 'refused', r.liftoffTW, hex(r.reason));
      else {
        const L = r.losses;
        W.add(...head, 'ok', r.upperStage, r.upperPropellant, r.massAtInsertion, r.deltaV, L.orbitalSpeed, L.rotation, L.gravity, L.climb, L.drag, L.steering, L.backPressure, L.circularization, r.liftoffTW, r.kick, ...usesRec(r.stages));
      }
    } catch (e) {
      W.add(...head, 'ERR', hex((e as Error).message));
    }
  };
  const oneDirect = (vid: string, stack: Stage[], geom: AscentGeometry, b: AscentBody, c3: number, hI: number, tag: string) => {
    const B = body(b);
    const head = ['dasc', vid, b.id, tag, B.gm, B.referenceRadius, c3, hI, geom.alongTrack, geom.crossTrack, ...stagesRec(stack)] as const;
    try {
      const r = computeDirectAscent(stack, { gm: B.gm, radius: B.referenceRadius, c3, injectionAltitudeM: hI }, geom, b);
      if (!r.ok) W.add(...head, 'refused', r.liftoffTW, hex(r.reason));
      else {
        const L = r.losses;
        const bo = r.burnout;
        W.add(...head, 'ok', r.upperStage, r.upperPropellant, r.massAtInsertion, r.deltaV, L.injectionSpeed, L.rotation, L.gravity, L.climb, L.drag, L.steering, L.backPressure, r.liftoffTW, r.kick,
          bo.time, bo.altitudeM, bo.speed, bo.horizontalSpeed, bo.radialSpeed, bo.flightPathAngle, bo.downrange, bo.c3, r.targetC3, r.achievedC3, r.shortfall, r.cutoff, ...usesRec(r.stages));
      }
    } catch (e) {
      W.add(...head, 'ERR', hex((e as Error).message));
    }
  };

  let k = 0;
  let kp = 0;
  let kd = 0;
  for (const v of vehicles) {
    for (const s of LAUNCH_SITES) {
      const span = (s.azimuthMaxDeg - s.azimuthMinDeg + 360) % 360;
      const azs = [s.azimuthMinDeg, s.azimuthMaxDeg, s.azimuthMinDeg + span * 0.5, s.azimuthMinDeg + span * rand()];
      for (const az of azs) {
        const t = (-50 + 150 * rand()) * YEAR;
        const geom = launchGeometry(s, t, az);
        W.add('geom', s.id, t, az, geom.alongTrack, geom.crossTrack);
        for (let j = 0; j < 3; j++) {
          const c = craft[(k + j) % craft.length];
          const alt = alts[kp++ % alts.length];
          one(v.id, [...v.stages, c], geom, ASCENT_BODIES.earth, alt, s.id);
        }
        for (let j = 0; j < 3; j++) {
          const c = craft[(k + j) % craft.length];
          oneDirect(v.id, [...v.stages, c], geom, ASCENT_BODIES.earth, c3s[kd % c3s.length], hIs[kd % hIs.length], s.id);
          kd++;
          k++;
        }
      }
    }
  }
  // Random stacks (2-4 lower stages, 1-3 engines, random flags): every refusal path.
  for (let i = 0; i < 400; i++) {
    const ns = 2 + Math.floor(rand() * 3);
    const st: Stage[] = [];
    let above = 500 + 20000 * rand();
    const top: Stage = { wetMass: above, dryMass: above * (0.2 + 0.5 * rand()), engines: [{ thrust: 1000 + 50000 * rand(), isp: 280 + 150 * rand() }] };
    for (let j = 0; j < ns; j++) {
      const prop = above * (2 + 8 * rand());
      const dry = prop * (0.04 + 0.12 * rand());
      const tw = j === ns - 1 ? 1.05 + 1.2 * rand() : 0.3 + 1.5 * rand();
      const ne = 1 + Math.floor(rand() * 3);
      const engines: Engine[] = [];
      for (let e = 0; e < ne; e++) {
        const en: Engine = { thrust: (tw * (above + prop + dry) * 9.81) / ne, isp: 260 + 200 * rand() };
        const r = rand();
        engines.push(r < 0.08 ? { ...en, restartable: false } : r < 0.16 ? { ...en, throttleable: false } : r < 0.2 ? { ...en, restartable: false, throttleable: false } : en);
      }
      st.unshift({ wetMass: prop + dry, dryMass: dry, engines });
      above += prop + dry;
    }
    const s = LAUNCH_SITES[i % LAUNCH_SITES.length];
    const geom = { alongTrack: -100 + 500 * rand(), crossTrack: -300 + 600 * rand() };
    one('random', [...st, top], geom, ASCENT_BODIES.earth, i % 9 === 0 ? 20e3 + 160e3 * rand() : 150e3 + 1500e3 * rand(), s.id);
    oneDirect('random', [...st, top], geom, ASCENT_BODIES.earth, -60e6 + 100e6 * rand(), 120e3 + 400e3 * rand(), s.id);
  }
  // Synthetic geometries, the Moon, a bare spacecraft (n < 2) and degenerate stacks.
  const geoms: AscentGeometry[] = [{ alongTrack: 0, crossTrack: 0 }, { alongTrack: -465, crossTrack: 0 }, { alongTrack: 400, crossTrack: -200 }, { alongTrack: -0, crossTrack: -0 }];
  for (const g of geoms) {
    for (const v of vehicles) {
      one(v.id, [...v.stages, craft[0]], g, ASCENT_BODIES.earth, 300e3, 'synthetic');
      oneDirect(v.id, [...v.stages, craft[0]], g, ASCENT_BODIES.earth, -1.5e6, 200e3, 'synthetic');
    }
  }
  const lander: Stage[] = [{ wetMass: 6000, dryMass: 2000, engines: [{ thrust: 45000, isp: 311 }] }, craft[2]];
  for (const alt of [15e3, 18e3, 50e3, 100e3]) one('lander', lander, geoms[0], ASCENT_BODIES.moon, alt, 'moon');
  for (const c3 of [-2.5e6, -1e6, 0.5e6]) oneDirect('lander', lander, geoms[0], ASCENT_BODIES.moon, c3, 20e3, 'moon');
  one('bare', [craft[0]], geoms[0], ASCENT_BODIES.earth, 200e3, 'bare');
  oneDirect('bare', [craft[0]], geoms[0], ASCENT_BODIES.earth, 0, 200e3, 'bare');
  const zero: Stage[] = [{ wetMass: 0, dryMass: 0, engines: [{ thrust: 1e6, isp: 300 }] }, { wetMass: 0, dryMass: 0, engines: [{ thrust: 1, isp: 1 }] }];
  one('zero', zero, geoms[0], ASCENT_BODIES.earth, 200e3, 'zero');
  oneDirect('zero', zero, geoms[0], ASCENT_BODIES.earth, 0, 200e3, 'zero');
  writeFileSync(OUT + 'ascent.txt', W.text());
});
