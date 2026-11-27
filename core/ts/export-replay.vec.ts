/**
 * Replay vectors (core/fixtures/generated/replay.txt) for core/src/mission/{events,replay}.rs.
 *
 * Corpus: every campaign reference plan (mission x offered site), the pinned
 * model-2 and staged fixtures, and perturbed variants of the Earth-Moon
 * references (burns shifted, the first burn cut short, a retrograde first
 * burn that ends in the atmosphere or at the surface, separations moved,
 * no events but impacts with stopOnAtmosphere false and a watched-body list,
 * tiny step and event budgets, a degenerate orbital-frame burn, a version
 * mismatch). For each: the plan (its canonical encoding), the replay options,
 * and the whole result: outcome, reason, digest, every event (kind, body,
 * time, distance, altitude, speed, relative state, mass, sphere), burn and
 * stage reports, launch insertion, ascent totals, final state, step count,
 * and a sample of dense-output states seen by onStep.
 * World: the real ephemeris with the shipped checkpoint asset (test/helpers/real-world.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { Lines } from './shared';
import { CAMPAIGN } from '../../src/mission/campaign';
import { encodePlan, makePlan, type MissionPlan } from '../../src/mission/plan';
import { replay, type ReplayOptions } from '../../src/mission/replay';
import { missionReplayOptions, type CompleteMission } from '../../src/mission/objectives';
import { SOLUTIONS, solutionPlan } from '../../test/helpers/campaign-solutions';
import { realWorld } from '../../test/helpers/real-world';
import * as STAGED from '../../src/fixtures/staged-replay';
import * as M2 from '../../src/fixtures/model2-replay';
import { sandboxSpheres } from '../../src/app/replay-options';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';

it('export replay vectors', () => {
  const W = new Lines();
  const { world } = realWorld();
  const fp = world.fingerprint;
  const run = (name: string, plan: MissionPlan, opts: ReplayOptions) => {
    let s: string;
    try {
      s = encodePlan(plan);
    } catch {
      return; // not encodable (a perturbation outside the format): skip
    }
    const sph = opts.spheres ?? [];
    W.add('replay', name, s, opts.stopOnAtmosphere === false ? 'noatm' : 'atm', opts.maxSteps ?? 2_000_000, opts.maxEvents ?? 200_000,
      String(opts.bodies ? opts.bodies.length : -1), ...(opts.bodies ?? []), String(sph.length), ...sph.flatMap((x) => [x.body, x.radius]),
      opts.allowVersionMismatch ? 'anyversion' : 'version');
    const samples: number[][] = [];
    let k = 0;
    const out = new Float64Array(7);
    const r = replay(plan, world, {
      ...opts,
      onStart: (t, y) => samples.push([-1, t, ...Array.from(y)]),
      onStep: (t, tPrev, interp) => {
        if (k++ % 97 === 0) {
          const tm = tPrev + (t - tPrev) * 0.375;
          interp(tm, out);
          samples.push([k - 1, tm, ...out]);
        }
      },
    });
    W.add('result', r.outcome, hex(r.reason), r.digest, r.steps, r.elapsed, r.finalT, r.deltaV, r.propellantUsed, r.totalDeltaV, String(r.finalState.length), r.finalState);
    for (const e of r.events) W.add('ev', e.kind, e.body, e.t, e.distance, e.altitude, e.speed, e.rel, e.mass, e.sphere ?? NaN);
    for (const b of r.burns) W.add('burn', b.burnTime, b.propellant, b.deltaV);
    for (const st of r.stages) W.add('stage', st.stage, st.propellantUsed, st.propellantLeft, st.deltaV, st.ascentDeltaV, st.separatedAt ?? NaN, st.droppedInAscent ? 1 : 0);
    if (r.launch) W.add('launch', r.launch.t, r.launch.state, r.launch.geocentric ?? [], r.launch.inclinationDeg ?? NaN);
    const a = r.ascent ?? r.directAscent;
    if (a) W.add('ascent', a.upperStage, a.upperPropellant, a.massAtInsertion, a.deltaV);
    for (const x of samples) W.add('sample', x);
    W.add('end', String(r.events.length), String(r.burns.length), String(r.stages.length), String(samples.length));
  };

  // The pinned fixtures.
  // As src/app/*replay*.test.ts run them: the sandbox's sphere list (computed by
  // the app, with Math.pow; here it is only an input, recorded in the vector).
  run('model2', makePlan({ ...M2.PLAN, data: fp }), { spheres: sandboxSpheres() });
  run('staged', makePlan({ ...STAGED.PLAN, data: fp }), { spheres: sandboxSpheres() });
  run('model2-nospheres', makePlan({ ...M2.PLAN, data: fp }), {});

  // State starts (format 1): a LEO orbit with inertial and orbital burns, an
  // orbital-frame burn with zero velocity relative to its body (physics-error),
  // a start inside the Earth, and an unknown frame body.
  const sc = { wetMass: 1000, dryMass: 500, engines: [{ thrust: 1000, isp: 300 }] };
  const leo = { kind: 'state' as const, center: 'earth', state: [7e6, 0, 0, 0, 7546, 0] as [number, number, number, number, number, number] };
  run('state-leo', makePlan({ data: fp, epoch: 3e8, duration: 20000, rtol: 1e-10, start: leo, spacecraft: sc,
    burns: [{ start: 1000, duration: 100, engine: 0, direction: [0, 1, 0.2], frame: { kind: 'inertial' } }, { start: 5000, duration: 300, engine: 0, direction: [-1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }), { spheres: [{ body: 'earth', radius: 1e7 }] });
  run('state-degenerate', makePlan({ data: fp, epoch: 3e8, duration: 1000, rtol: 1e-10, start: { ...leo, state: [7e6, 0, 0, 0, 0, 0] }, spacecraft: sc,
    burns: [{ start: 0, duration: 10, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }), {});
  run('state-inside', makePlan({ data: fp, epoch: 3e8, duration: 1000, rtol: 1e-10, start: { ...leo, state: [6e6, 0, 0, 0, 7000, 0] }, spacecraft: sc, burns: [] }), {});
  run('state-atm', makePlan({ data: fp, epoch: 3e8, duration: 1000, rtol: 1e-10, start: { ...leo, state: [6.45e6, 0, 0, 0, 7800, 0] }, spacecraft: sc, burns: [] }), {});

  for (const m of CAMPAIGN as readonly CompleteMission[]) {
    const sols = SOLUTIONS[m.id] ?? {};
    for (const site of Object.keys(sols)) {
      const base = solutionPlan(m, site, fp);
      const opts = missionReplayOptions(m);
      run(`${m.id}/${site}`, base, opts);
      // Perturbations only for the Earth-Moon references (short flights).
      if (base.duration > 20 * 86400) continue;
      const b0 = base.burns[0];
      run(`${m.id}/${site}/shift`, { ...base, burns: base.burns.map((b) => ({ ...b, start: b.start + 60 })) }, opts);
      run(`${m.id}/${site}/short`, { ...base, burns: [{ ...b0, duration: b0.duration * 0.5 }, ...base.burns.slice(1)] }, opts);
      run(`${m.id}/${site}/deorbit`, { ...base, duration: Math.min(base.duration, 86400), burns: [{ ...b0, duration: b0.duration * 0.4, direction: [-1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }, opts);
      if (site === Object.keys(sols)[0]) {
        run(`${m.id}/${site}/deorbit-noatm`, { ...base, duration: Math.min(base.duration, 86400), burns: [{ ...b0, duration: b0.duration * 0.4, direction: [-1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }, { ...opts, stopOnAtmosphere: false });
        run(`${m.id}/${site}/watch`, base, { spheres: [{ body: 'earth', radius: 2e7 }, { body: 'moon', radius: 6e7 }], bodies: ['earth', 'moon', 'sun'] });
        run(`${m.id}/${site}/steps`, base, { ...opts, maxSteps: 150 });
        run(`${m.id}/${site}/events`, base, { ...opts, maxEvents: 3 });
        run(`${m.id}/${site}/sep-early`, { ...base, separations: (base.separations ?? []).map((x) => ({ time: x.time - 100 })) }, opts);
        run(`${m.id}/${site}/version`, { ...base, data: '00000000' }, opts);
        run(`${m.id}/${site}/version-ok`, { ...base, data: '00000000' }, { ...opts, allowVersionMismatch: true });
        run(`${m.id}/${site}/badsphere`, base, { spheres: [{ body: 'earth', radius: -1 }] });
        run(`${m.id}/${site}/badbody`, base, { bodies: ['earth', 'vulcan'] });
      }
    }
  }
  writeFileSync(OUT + 'replay.txt', W.text());
}, 3_600_000);
