/**
 * The replay corpus shared by core/ts/export-replay.vec.ts and
 * core/ts/export-objectives.vec.ts: every campaign reference plan (mission x
 * offered site), the pinned model-2 and staged fixtures, state starts, and
 * perturbed variants of the Earth-Moon references. `mission` is set for the
 * plans flown for a campaign mission (references and their perturbations).
 */
import { CAMPAIGN } from '../../src/mission/campaign';
import { makePlan, type MissionPlan } from '../../src/mission/plan';
import type { ReplayOptions } from '../../src/mission/replay';
import { missionReplayOptions, type CompleteMission } from '../../src/mission/objectives';
import { SOLUTIONS, solutionPlan } from '../../test/helpers/campaign-solutions';
import * as STAGED from '../../src/fixtures/staged-replay';
import * as M2 from '../../src/fixtures/model2-replay';
import { sandboxSpheres } from '../../src/app/replay-options';

export interface CorpusCase {
  readonly name: string;
  readonly plan: MissionPlan;
  readonly opts: ReplayOptions;
  readonly mission?: CompleteMission;
  /** A campaign reference plan (mission x offered site), unperturbed. */
  readonly reference?: boolean;
}

export function replayCorpus(fp: string): CorpusCase[] {
  const out: CorpusCase[] = [];
  const run = (name: string, plan: MissionPlan, opts: ReplayOptions, mission?: CompleteMission, reference?: boolean) => out.push({ name, plan, opts, mission, reference });

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
      run(`${m.id}/${site}`, base, opts, m, true);
      // Perturbations only for the Earth-Moon references (short flights).
      if (base.duration > 20 * 86400) continue;
      const b0 = base.burns[0];
      run(`${m.id}/${site}/shift`, { ...base, burns: base.burns.map((b) => ({ ...b, start: b.start + 60 })) }, opts, m);
      run(`${m.id}/${site}/short`, { ...base, burns: [{ ...b0, duration: b0.duration * 0.5 }, ...base.burns.slice(1)] }, opts, m);
      run(`${m.id}/${site}/deorbit`, { ...base, duration: Math.min(base.duration, 86400), burns: [{ ...b0, duration: b0.duration * 0.4, direction: [-1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }, opts, m);
      if (site === Object.keys(sols)[0]) {
        run(`${m.id}/${site}/deorbit-noatm`, { ...base, duration: Math.min(base.duration, 86400), burns: [{ ...b0, duration: b0.duration * 0.4, direction: [-1, 0, 0], frame: { kind: 'orbital', body: 'earth' } }] }, { ...opts, stopOnAtmosphere: false }, m);
        run(`${m.id}/${site}/watch`, base, { spheres: [{ body: 'earth', radius: 2e7 }, { body: 'moon', radius: 6e7 }], bodies: ['earth', 'moon', 'sun'] }, m);
        run(`${m.id}/${site}/steps`, base, { ...opts, maxSteps: 150 }, m);
        run(`${m.id}/${site}/events`, base, { ...opts, maxEvents: 3 }, m);
        run(`${m.id}/${site}/sep-early`, { ...base, separations: (base.separations ?? []).map((x) => ({ time: x.time - 100 })) }, opts, m);
        run(`${m.id}/${site}/version`, { ...base, data: '00000000' }, opts, m);
        run(`${m.id}/${site}/version-ok`, { ...base, data: '00000000' }, { ...opts, allowVersionMismatch: true }, m);
        run(`${m.id}/${site}/badsphere`, base, { spheres: [{ body: 'earth', radius: -1 }] }, m);
        run(`${m.id}/${site}/badbody`, base, { bodies: ['earth', 'vulcan'] }, m);
      }
    }
  }
  return out;
}

/** The replay record of a case (the format core/src/parity4.rs reads); undefined if the plan is not encodable. */
export function replayRecord(c: CorpusCase, encode: (p: MissionPlan) => string): (string | number)[] | undefined {
  let s: string;
  try {
    s = encode(c.plan);
  } catch {
    return undefined; // not encodable (a perturbation outside the format): skip
  }
  const opts = c.opts;
  const sph = opts.spheres ?? [];
  return ['replay', c.name, s, opts.stopOnAtmosphere === false ? 'noatm' : 'atm', opts.maxSteps ?? 2_000_000, opts.maxEvents ?? 200_000,
    String(opts.bodies ? opts.bodies.length : -1), ...(opts.bodies ?? []), String(sph.length), ...sph.flatMap((x) => [x.body, x.radius]),
    opts.allowVersionMismatch ? 'anyversion' : 'version'];
}
