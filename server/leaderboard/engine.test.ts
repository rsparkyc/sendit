/**
 * The real engine (strict decoder, the mission layer's conformance check,
 * real ephemeris with the checkpoint asset, the ascent model, replay and
 * objective evaluation) behind the full HTTP/service/store path. One lunar
 * free return on its launch vehicle (format 2), about a second in total.
 */
import { describe, expect, it } from 'vitest';
import { createEngine, versionOf } from './engine';
import { checkPlanConformance } from '../../src/mission/objectives';
import { LIMITS } from '../../src/mission/plan';
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
    // Total delta-v: the ascent on the mission's vehicle (~9 km/s) plus the flight (~3.2 km/s), as the mission's reference records it.
    const ref = mission!.def.launchSites!.find((o) => o.site === 'kourou');
    expect(ref?.offered && Math.abs(r.body.result.deltaV - ref.deltaV)).toBeLessThan(0.15);
    expect(r.body.result.deltaV).toBe(v.deltaV);
  });

  it('per-site and all-sites boards rank the real flights by total delta-v', async () => {
    const t = await submit(encodePlan(fx.freeReturn(engine.fingerprint, { site: 'tanegashima' })), 5);
    expect(t.status).toBe(200);
    expect(t.body.site).toBe('tanegashima');
    const board = (site: string) => h.call('GET', '/api/leaderboard/board', { query: { mission: mission!.id, version: mission!.version, board: 'deltaV', site } });
    const all = (await board('all')).body.entries;
    expect(all.map((e: { site: string }) => e.site)).toEqual(['kourou', 'tanegashima']); // 12181.3 < 12181.7 m/s
    expect(all[0].deltaV).toBeLessThan(all[1].deltaV);
    expect((await board('tanegashima')).body.entries).toHaveLength(1);
    expect((await board('kourou')).body.entries).toHaveLength(1);
  });

  it('a tampered plan is re-flown, not trusted: the same burn a minute earlier misses the return', async () => {
    const r = await submit(encodePlan(fx.freeReturn(engine.fingerprint, { burnShift: -60 })), 2);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('objectives-not-met');
  });

  it('the mission’s own spacecraft, vehicle, parking band and duration are enforced', async () => {
    const p = fx.freeReturn(engine.fingerprint);
    let r = await submit(encodePlan({ ...p, spacecraft: { ...p.spacecraft, engines: [{ thrust: 10e3, isp: 470 }] } }), 3);
    expect(r.body.error).toBe('rule-violation');
    // A lighter upper stage (more delta-v for free) is refused, bit for bit.
    const lower = p.lowerStages!;
    r = await submit(encodePlan({ ...p, lowerStages: [lower[0], { ...lower[1], dryMass: lower[1].dryMass - 1 }] }), 3);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('rule-violation');
    expect(JSON.stringify(r.body)).toMatch(/mission vehicle/);
    // A parking orbit outside the band (a free low orbit, or a high one) is refused.
    const st = p.start as { kind: 'launch'; site: string; params: readonly number[]; ascent: 'vehicle' };
    for (const alt of [170e3, 1100e3]) {
      const q = st.params.slice();
      q[2] = alt;
      r = await submit(encodePlan({ ...p, start: { ...st, params: q } }), 3);
      expect(r.body.error).toBe('rule-violation');
      expect(JSON.stringify(r.body)).toMatch(/parking altitude/);
    }
    r = await submit(encodePlan({ ...p, duration: 40 * 365.25 * 86400 }), 3);
    expect(r.body.error).toBe('rule-violation');
  });

  it('a plan made for the previous mission version (a free delivery to orbit) is refused with the editor’s reason', async () => {
    const old = fx.oldFreeReturn(engine.fingerprint);
    expect(old.format).toBe(1);
    const editor = checkPlanConformance(mission!.def, old);
    expect(editor.map((i) => i.code)).toEqual(['start-kind']);
    const r = await submit(encodePlan(old), 4);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('rule-violation');
    expect(r.body.message).toContain(editor[0].message);
    expect(r.body.message).toMatch(/earlier version of the mission/);
  });

  it('the largest staged plan the plan layer allows fits the request and stored-plan limits', () => {
    const enc = encodePlan(fx.largestStaged(engine.fingerprint));
    expect(enc.length).toBeLessThanOrEqual(LIMITS.maxEncodedLength);
    const body = JSON.stringify({ missionId: 'jupiter-saturn', missionVersion: '4', plan: enc, name: 'x'.repeat(40), secret: secret(9) });
    expect(new TextEncoder().encode(body).length).toBeLessThan(h.config.maxBodyBytes);
    console.log(`largest staged plan: ${enc.length} chars; request ${body.length} bytes`);
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
