/**
 * Replay API for the editor: observation hooks (bit-identical results), abort,
 * structured validation, launch insertion info; plus the PHYSICS_MODEL guard.
 */
import { describe, expect, it } from 'vitest';
import { launchToParams } from '../src/mission/launch';
import { makePlan, validatePlan, validatePlanIssues, type MissionPlan, type PlanBurn } from '../src/mission/plan';
import { replay } from '../src/mission/replay';
import { PHYSICS_MODEL } from '../src/mission/world';
import { realWorld } from './helpers/real-world';

const { world } = realWorld();
const LIFTOFF = 8.5e8; // 2026-12 TDB
const pro = (start: number, duration: number): PlanBurn => ({ start, duration, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } });

/** Canonical replay: Cape launch, an apogee-raising burn, two days of flight (J2, Moon, Sun, events, finite burn). */
function canonical(over: Partial<MissionPlan> = {}): MissionPlan {
  return makePlan({
    data: world.fingerprint, epoch: LIFTOFF, duration: 2 * 86400, rtol: 1e-10,
    start: { kind: 'launch', site: 'cape-canaveral', params: launchToParams({ mode: 'parking-orbit', siteId: 'cape-canaveral', launchTime: LIFTOFF, azimuthDeg: 90, altitudeM: 250e3 }) },
    spacecraft: { wetMass: 20000, dryMass: 4000, engines: [{ thrust: 100e3, isp: 450 }] },
    burns: [pro(3000, 300)],
    ...over,
  });
}

/**
 * GOLDEN REPLAYS. Each entry: physics model, world fingerprint, digest of the
 * canonical replay. If this test fails, replay results changed:
 *  - fingerprint changed too (body data edited): append an entry with the new
 *    data and digest (the model may stay);
 *  - fingerprint unchanged: physics code changed results. Bump PHYSICS_MODEL
 *    in src/mission/world.ts (which also changes the fingerprint) and append
 *    the new entry. Never edit an old entry: (model, data) pairs are unique,
 *    so a changed digest cannot be recorded without a new model or data.
 */
const GOLDEN: readonly { model: number; data: string; digest: string }[] = [
  { model: 1, data: '2cb83544', digest: '342786722dea0bca' },
];

describe('replay hooks and abort', () => {
  const plan = canonical();
  const plain = replay(plan, world);

  it('canonical replay completes', () => {
    expect(plain.outcome).toBe('completed');
  });

  it('digest is identical with and without the sampling hooks', () => {
    const tmp = new Float64Array(7);
    const samples: number[] = [];
    let started = NaN;
    const r = replay(plan, world, {
      onStart: (t) => { started = t; },
      onStep: (t, tPrev, interp) => { for (let i = 1; i <= 8; i++) { const ti = tPrev + ((t - tPrev) * i) / 8; interp(ti, tmp); samples.push(ti, tmp[0]); } },
    });
    expect(r.digest).toBe(plain.digest);
    expect(r).toEqual(plain);
    expect(started).toBe(plan.epoch + 540);
    expect(samples.length / 2).toBe(8 * plain.steps);
    expect(samples[samples.length - 2]).toBe(plain.finalT);
  });

  it('aborts with a distinct outcome via shouldStop or signal', () => {
    let n = 0;
    const a = replay(plan, world, { shouldStop: () => ++n > 10 });
    expect(a.outcome).toBe('aborted');
    expect(a.ok).toBe(false);
    expect(a.steps).toBe(11);
    const ctl = new AbortController();
    ctl.abort();
    expect(replay(plan, world, { signal: ctl.signal }).outcome).toBe('aborted');
  });

  it('reports the launch insertion', () => {
    const l = plain.launch!;
    expect(l.t).toBe(plan.epoch + 540);
    expect(l.state.length).toBe(6);
    expect(l.inclinationDeg!).toBeGreaterThan(28);
    expect(l.inclinationDeg!).toBeLessThan(29);
    expect(Math.hypot(l.geocentric![0], l.geocentric![1], l.geocentric![2])).toBeCloseTo(6378137 + 250e3, -4);
  });

  it('matches the golden digest for this PHYSICS_MODEL and data', () => {
    const last = GOLDEN[GOLDEN.length - 1];
    expect(new Set(GOLDEN.map((g) => `${g.model}/${g.data}`)).size, 'each (model, data) pair is recorded once').toBe(GOLDEN.length);
    expect(PHYSICS_MODEL, 'PHYSICS_MODEL must match the newest GOLDEN entry').toBe(last.model);
    expect(world.fingerprint, 'body data changed: append a GOLDEN entry').toBe(last.data);
    expect(plain.digest, 'replay results changed: bump PHYSICS_MODEL and append a GOLDEN entry (see comment)').toBe(last.digest);
  });
});

describe('structured validation', () => {
  it('gives code, path and burn; strings unchanged', () => {
    const bad = canonical({ burns: [pro(3000, 300), { ...pro(3100, 10), direction: [0, 0, 0] }] });
    const issues = validatePlanIssues(bad);
    const i = issues.find((x) => x.code === 'burn-overlap')!;
    expect(i.burn).toBe(1);
    expect(i.path).toBe('burns[1].start');
    expect(issues.find((x) => x.code === 'burn-direction')!.burn).toBe(1);
    expect(validatePlan(bad)).toEqual(issues.map((x) => x.message));
  });

  it('checks launch site and azimuth corridor at validation and in replay', () => {
    const base = canonical();
    const site = { ...base, start: { kind: 'launch' as const, site: 'nowhere', params: base.start.kind === 'launch' ? base.start.params : [] } };
    expect(validatePlanIssues(site).map((x) => x.code)).toContain('launch-site');
    expect(validatePlan(site, { launch: 'structural' })).toEqual([]);
    const az = canonical({ start: { kind: 'launch', site: 'cape-canaveral', params: launchToParams({ mode: 'parking-orbit', siteId: 'cape-canaveral', launchTime: LIFTOFF, azimuthDeg: 180, altitudeM: 250e3 }) } });
    const iss = validatePlanIssues(az);
    expect(iss.map((x) => [x.code, x.path])).toEqual([['launch-azimuth', 'start.params[1]']]);
    const r = replay(az, world);
    expect(r.outcome).toBe('invalid-plan');
    expect(r.reason).toMatch(/range-safety corridor/);
  });
});
