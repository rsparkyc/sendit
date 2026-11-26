/**
 * The real engine (strict decoder, the mission layer's conformance check,
 * real ephemeris with the checkpoint asset, replay and objective evaluation)
 * behind the full HTTP/service/store path. One lunar free return, about a
 * second in total.
 */
import { describe, expect, it } from 'vitest';
import { createEngine, versionOf } from './engine';
import { encodePlan, fixtures, TLI_STAGE } from './fixtures';
import { readAsset } from './node-io';
import { Harness, secret } from './test-kit';

const bytes = await readAsset('../../src/physics/data/checkpoints-1950-2100.bin', import.meta.url);
const engine = createEngine({ checkpoints: bytes });
const fx = fixtures(bytes);
const mission = engine.mission('lunar-free-return');

describe.skipIf(!mission)('real engine: lunar free return', () => {
  const h = new Harness(undefined, { engine });
  const submit = (plan: string, player = 1) =>
    h.call('POST', '/api/leaderboard/submit', { body: { missionId: mission!.id, missionVersion: mission!.version, plan, name: 'Ada', secret: secret(player) } });

  it('scores the author’s solution with the mission layer’s keys and the replay digest', async () => {
    const plan = encodePlan(fx.freeReturn(engine.fingerprint));
    const v = engine.verify(engine.decode(plan), mission!, { deadline: Date.now() + 60_000, maxSteps: 250_000 });
    expect(v).toMatchObject({ status: 'ok', success: true });
    const r = await submit(plan);
    expect(r.status).toBe(200);
    expect(r.body.result.digest).toBe(v.digest);
    expect(r.body.result.score).toBe(v.score);
    expect(r.body.result.score).toBeGreaterThan(0);
    expect(Number.isInteger(r.body.result.missionTime)).toBe(true); // whole seconds
    expect(Number.isInteger(Math.round(r.body.result.deltaV * 10))).toBe(true); // tenths of m/s
    expect(r.body.ranks.combined.rank).toBe(1);
  });

  it('a tampered plan is re-flown, not trusted: the same burn a minute earlier misses the return', async () => {
    const r = await submit(encodePlan(fx.freeReturn(engine.fingerprint, { burnStart: 2840 })), 2);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('objectives-not-met');
  });

  it('the mission’s own spacecraft and duration are enforced', async () => {
    const p = fx.freeReturn(engine.fingerprint);
    let r = await submit(encodePlan({ ...p, spacecraft: { ...TLI_STAGE, engines: [{ thrust: 200e3, isp: 470 }] } }), 3);
    expect(r.body.error).toBe('rule-violation');
    r = await submit(encodePlan({ ...p, duration: 40 * 365.25 * 86400 }), 3);
    expect(r.body.error).toBe('rule-violation');
  });

  it('step and wall-clock budgets stop the replay', () => {
    const p = fx.freeReturn(engine.fingerprint);
    expect(engine.verify(p, mission!, { deadline: Date.now() + 60_000, maxSteps: 20 }).status).toBe('limit');
    const far = { ...p, epoch: p.epoch + 3e8, start: { ...p.start, params: [p.epoch + 3e8, ...(p.start as { params: readonly number[] }).params.slice(1)] } } as typeof p;
    expect(engine.verify(far, mission!, { deadline: Date.now() - 1, maxSteps: 250_000 }).status).toBe('timeout');
  });

  it('every catalogue mission has a stable id and version', () => {
    for (const m of engine.missions()) {
      expect(m.id).toMatch(/^[a-z0-9_-]+$/);
      expect(m.version).toBe(versionOf(m.def));
    }
  });
});
