/**
 * Leaderboard handler end to end: HTTP layer -> service -> store -> in-memory
 * DynamoDB fake (fake-dynamo.ts says what it does not model), with the real
 * plan decoder and mission rules and a stand-in replay (test-kit.ts fakeFly).
 */
import { describe, expect, it } from 'vitest';
import { createEngine, type Engine } from './engine';
import { withHidden } from './group';
import { reverify } from './reverify';
import { fixedLaunch, OLD_VERSION_MESSAGE, vehicleLaunch } from '../../src/mission/objectives';
import { catalogueStages, PARKING_BAND } from '../../src/mission/vehicles';
import { CONFIG, CRAFT, encode, fakeFly, Harness, plan, secret, SITES_MISSION, TEST_MISSION } from './test-kit';

const DAY = 86400;
const V = String(TEST_MISSION.version);

describe('submit: validation and rejection', () => {
  it('accepts a valid flight and returns what the server computed', async () => {
    const h = new Harness();
    const r = await h.submit(1, plan(h.engine, { burns: [150] }));
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ deltaV: 1500, missionTime: 5 * DAY });
    expect(r.body.result.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(r.body.improved).toEqual({ combined: true, deltaV: true, time: true });
    expect(r.body.player).toMatchObject({ name: 'Player 1' });
    expect(r.body.player.tag).toMatch(/^[0-9a-z]{5}$/);
    expect(r.body.ranks.combined.rank).toBe(1);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('refuses any client-supplied score or extra field before doing any work', async () => {
    const h = new Harness();
    for (const extra of [{ score: 999999 }, { deltaV: 0 }, { result: { score: 1 } }]) {
      const r = await h.submit(1, plan(h.engine), extra);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('unexpected-field');
    }
    expect(h.flights).toBe(0);
    expect(h.db.calls).toHaveLength(0);
  });

  it('rejects malformed plans with invalid-plan and never flies them', async () => {
    const h = new Harness();
    const good = encode(plan(h.engine));
    const cases = ['', 'not a plan!', good.slice(0, -5), good + 'AAAA', 'A' + good.slice(1), 'x'.repeat(16385)];
    for (const p of cases) {
      const r = await h.submit(1, p);
      expect(r.status, p.slice(0, 20)).toBe(422);
      expect(r.body.error).toBe('invalid-plan');
    }
    // Launch semantics are checked too (azimuth outside Kourou's corridor).
    const bad = plan(h.engine);
    const params = [...(bad.start as { params: readonly number[] }).params];
    params[1] = 180;
    const r = await h.submit(1, { ...bad, start: { kind: 'launch', site: 'kourou', params } });
    expect(r.body.error).toBe('invalid-plan');
    expect(r.body.message).toMatch(/corridor/);
    expect(h.flights).toBe(0);
  });

  it('rejects oversized bodies by declared length and by actual size', async () => {
    const h = new Harness();
    const big = JSON.stringify({ missionId: 'x', missionVersion: '1', plan: 'A'.repeat(30_000), name: 'n', secret: secret(1) });
    let r = await h.call('POST', '/api/leaderboard/submit', { raw: big });
    expect(r.status).toBe(413);
    r = await h.call('POST', '/api/leaderboard/submit', { raw: '{}', headers: { 'content-length': '999999' } });
    expect(r.status).toBe(413);
    r = await h.call('POST', '/api/leaderboard/submit', { raw: '{not json' });
    expect(r.body.error).toBe('bad-request');
  });

  it('rejects unknown missions, old mission versions and plans from another physics build', async () => {
    const h = new Harness();
    let r = await h.call('POST', '/api/leaderboard/submit', { body: { missionId: 'nope', missionVersion: '1', plan: encode(plan(h.engine)), name: 'a', secret: secret(1) } });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('unknown-mission');
    r = await h.call('POST', '/api/leaderboard/submit', { body: { missionId: TEST_MISSION.id, missionVersion: '2', plan: encode(plan(h.engine)), name: 'a', secret: secret(1) } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'mission-version', detail: { current: V } });
    r = await h.submit(1, plan(h.engine, { data: '0badf00d' }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('version-mismatch');
    expect(r.body.detail).toEqual({ expected: { model: h.engine.model, data: h.engine.fingerprint }, got: { model: h.engine.model, data: '0badf00d' } });
    expect(h.flights).toBe(0);
  });

  it('reports a plan made under an older physics model as made for an older version', async () => {
    const h = new Harness();
    const old = { ...plan(h.engine), model: h.engine.model - 1, data: '2cb83544' }; // physics model 1's data stamp
    const r = await h.submit(1, old);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('version-mismatch');
    expect(r.body.message).toMatch(/made for an older version of the game \(physics model 1 \/ data 2cb83544\)/);
    expect(r.body.detail).toEqual({ expected: { model: h.engine.model, data: h.engine.fingerprint }, got: { model: h.engine.model - 1, data: '2cb83544' } });
    expect(h.flights).toBe(0);
  });

  it('refuses a parking orbit, ascent or circularisation the mission fixes (rules.launch)', async () => {
    const locked = { ...TEST_MISSION, rules: { ...TEST_MISSION.rules!, launch: fixedLaunch(200e3) } };
    const h = new Harness(CONFIG, { mission: locked });
    expect((await h.submit(1, plan(h.engine, { burns: [150] }))).status).toBe(200);
    const p = plan(h.engine, { burns: [150] });
    const params = [...(p.start as { params: readonly number[] }).params];
    for (const [i, v, code] of [[2, 2000e3, 'launch-altitude'], [3, 600, 'launch-ascent'], [4, 20, 'launch-ascent'], [5, 1, 'launch-ascent']] as const) {
      const q = params.slice();
      q[i] = v;
      const r = await h.submit(2, { ...p, start: { kind: 'launch', site: 'kourou', params: q } });
      expect(r.status, `params[${i}]`).toBe(422);
      expect(r.body.error).toBe('rule-violation');
      expect(r.body.detail.issues.map((x: { code: string; path: string }) => [x.code, x.path])).toEqual([[code, `start.params[${i}]`]]);
    }
    expect(h.flights).toBe(1);
  });

  it('rejects plans that break the mission rules', async () => {
    const h = new Harness();
    const cases: [Parameters<typeof plan>[1], RegExp][] = [
      [{ craft: { ...CRAFT, wetMass: 40000 } }, /wet mass/],
      [{ craft: { ...CRAFT, engines: [{ thrust: 2e6, isp: 450 }] } }, /thrust/],
      [{ site: 'cape-canaveral' }, /cape-canaveral not allowed/],
      [{ offset: -DAY }, /window/],
      [{ duration: 11 * DAY }, /duration/],
      [{ rtol: 1e-6 }, /tolerance/],
    ];
    for (const [spec, re] of cases) {
      const r = await h.submit(1, plan(h.engine, spec));
      expect(r.status, re.source).toBe(422);
      expect(r.body.error).toBe('rule-violation');
      expect(r.body.message).toMatch(re);
    }
    // A free 'state' start where the mission requires a launch.
    const p = plan(h.engine);
    const r = await h.submit(1, { ...p, start: { kind: 'state', center: 'earth', state: [7e6, 0, 0, 0, 7.5e3, 0] } });
    expect(r.body.error).toBe('rule-violation');
    expect(h.flights).toBe(0);
  });

  it('accepts the mission version as the string /missions returns, or as an integer', async () => {
    const h = new Harness();
    const r = await h.call('POST', '/api/leaderboard/submit', { body: { missionId: TEST_MISSION.id, missionVersion: TEST_MISSION.version, plan: encode(plan(h.engine)), name: 'a', secret: secret(1) } });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(V);
    const me = await h.call('POST', '/api/leaderboard/me', { body: { missionId: TEST_MISSION.id, missionVersion: TEST_MISSION.version, secret: secret(1) } });
    expect(me.body.player.name).toBe('a');
    expect((await h.call('POST', '/api/leaderboard/me', { body: { missionId: TEST_MISSION.id, missionVersion: 3.5, secret: secret(1) } })).body.error).toBe('bad-request');
    expect((await h.call('GET', '/api/leaderboard/missions')).body.missions[0].version).toBe(V);
  });

  it('rejects bad secrets and bad names', async () => {
    const h = new Harness();
    let r = await h.submit(1, plan(h.engine), { secret: 'short' });
    expect(r.body.error).toBe('bad-secret');
    r = await h.submit(1, plan(h.engine), { name: '​ ‮\u0007 ' });
    expect(r.body.error).toBe('bad-name');
    r = await h.submit(1, plan(h.engine), { name: 'B4dW0rd fan' });
    expect(r.body.error).toBe('name-rejected');
    r = await h.submit(1, plan(h.engine), { name: 'Official Admin' });
    expect(r.body.error).toBe('name-rejected');
  });

  it('reports a failed flight with its objective details and stores nothing', async () => {
    const h = new Harness();
    const r = await h.submit(1, plan(h.engine, { burns: [] }));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('objectives-not-met');
    expect(r.body.detail.objectives[0]).toMatchObject({ ok: false });
    expect((await h.board('combined')).body.entries).toHaveLength(0);
  });
});

describe('score cache and replay budget', () => {
  it('flies an exact plan once; resubmissions (any player) use the cached verdict', async () => {
    const h = new Harness();
    const p = plan(h.engine, { burns: [120] });
    expect((await h.submit(1, p)).status).toBe(200);
    expect((await h.submit(2, p)).status).toBe(200);
    expect((await h.submit(1, plan(h.engine, { burns: [] }))).status).toBe(422);
    expect((await h.submit(1, plan(h.engine, { burns: [] }))).status).toBe(422);
    expect(h.flights).toBe(2);
  });

  it('a replay that runs out of wall-clock time is a retryable 503 and is not cached', async () => {
    let n = 0;
    const h = new Harness(CONFIG, { fly: (p, m, o) => (n++ === 0 ? { ...fakeFly(p, m, o), status: 'timeout', success: false } : fakeFly(p, m, o)) });
    const p = plan(h.engine);
    const r = await h.submit(1, p);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('replay-timeout');
    expect(r.headers['retry-after']).toBe('30');
    expect((await h.submit(1, p)).status).toBe(200);
  });

  it('a flight over the step budget is refused (deterministically, so cached)', async () => {
    const h = new Harness(CONFIG, { fly: (p, m, o) => ({ ...fakeFly(p, m, o), status: 'limit', success: false, reason: 'more than 250000 integrator steps' }) });
    const r = await h.submit(1, plan(h.engine));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('replay-limit');
    expect((await h.submit(1, plan(h.engine))).body.error).toBe('replay-limit');
    expect(h.flights).toBe(1);
  });
});

describe('boards', () => {
  it('ranks each board by its own order, ties broken by the earlier submission', async () => {
    const h = new Harness();
    // p1: dv 1000, 5 d.   p2: dv 2000, 2 d.   p3: dv 1000, 5 d (tie with p1, later).
    await h.submit(1, plan(h.engine, { burns: [100], duration: 5 * DAY }));
    h.clock += 1000;
    await h.submit(2, plan(h.engine, { burns: [200], duration: 2 * DAY }));
    h.clock += 1000;
    await h.submit(3, plan(h.engine, { burns: [100], duration: 5 * DAY, offset: 60 }));
    const names = async (b: string) => (await h.board(b)).body.entries.map((e: { name: string }) => e.name);
    expect(await names('deltaV')).toEqual(['Player 1', 'Player 3', 'Player 2']);
    expect(await names('time')).toEqual(['Player 2', 'Player 1', 'Player 3']);
    // combined: p2 cost (2000/3000 + 2/5)/2 = 0.533 beats p1/p3 (1000/3000 + 1)/2 = 0.667.
    expect(await names('combined')).toEqual(['Player 2', 'Player 1', 'Player 3']);
    const b = (await h.board('deltaV')).body;
    expect(b.entries[0]).toMatchObject({ rank: 1, deltaV: 1000, missionTime: 5 * DAY });
    expect(b.entries[0].submittedAt).toBe(new Date(Date.UTC(2026, 10, 26, 12)).toISOString());
    expect(Object.keys(b.entries[0]).sort()).toEqual(['deltaV', 'missionTime', 'name', 'pid', 'rank', 'score', 'site', 'submittedAt', 'tag']);
    expect((await h.board('combined')).headers['cache-control']).toBe('public, max-age=10');
  });

  it('keeps one entry per player; a worse flight does not replace a better one, each board separately', async () => {
    const h = new Harness();
    await h.submit(1, plan(h.engine, { burns: [100], duration: 6 * DAY })); // dv 1000, 6 d
    h.clock += 1000;
    let r = await h.submit(1, plan(h.engine, { burns: [300], duration: 1 * DAY })); // dv 3000, 1 d: better time and combined, worse dv
    expect(r.body.improved).toEqual({ combined: true, deltaV: false, time: true });
    h.clock += 1000;
    r = await h.submit(1, plan(h.engine, { burns: [400], duration: 3 * DAY })); // worse everywhere
    expect(r.body.improved).toEqual({ combined: false, deltaV: false, time: false });
    for (const b of ['combined', 'deltaV', 'time']) expect((await h.board(b)).body.entries).toHaveLength(1);
    expect((await h.board('deltaV')).body.entries[0]).toMatchObject({ deltaV: 1000, missionTime: 6 * DAY });
    expect((await h.board('time')).body.entries[0]).toMatchObject({ deltaV: 3000, missionTime: 1 * DAY });
    // Equal result later: kept the earlier one (no improvement, submittedAt unchanged).
    h.clock += 1000;
    r = await h.submit(1, plan(h.engine, { burns: [100], duration: 6 * DAY, offset: 30 }));
    expect(r.body.improved.deltaV).toBe(false);
    expect(r.body.ranks.deltaV.submittedAt).toBe(new Date(Date.UTC(2026, 10, 26, 12)).toISOString());
  });

  it('finds the caller’s own rank outside the top N, paginates, and counts across query pages', async () => {
    const h = new Harness({ ...CONFIG, playerLimits: [[100, 60]], ipLimits: [[100, 60]] }, { pageSize: 7 });
    for (let i = 1; i <= 30; i++) await h.submit(i, plan(h.engine, { burns: [100 + i] }));
    const top = (await h.board('deltaV', 5)).body;
    expect(top.entries.map((e: { rank: number }) => e.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(top.entries[0].name).toBe('Player 1');
    const page2 = (await h.board('deltaV', 5, top.next)).body;
    expect(page2.entries.map((e: { rank: number; name: string }) => `${e.rank}:${e.name}`)).toEqual(['6:Player 6', '7:Player 7', '8:Player 8', '9:Player 9', '10:Player 10']);
    const me = (await h.me(23)).body;
    expect(me.player.name).toBe('Player 23');
    expect(me.ranks.deltaV).toMatchObject({ rank: 23, deltaV: 1230 });
    expect(me.ranks.time.rank).toBe(23); // all tie on time; earlier submission first
    expect((await h.me(99)).body).toMatchObject({ player: null, ranks: { combined: null, deltaV: null, time: null } });
    // Beyond the counting cap the rank is reported as "beyond".
    h.setEngine(h.engine, { ...h.config, maxRankCount: 10 });
    expect((await h.me(23)).body.ranks.deltaV).toMatchObject({ rank: null, beyond: 10 });
  });

  it('hidden entries leave every board and stay hidden when the player submits again', async () => {
    const h = new Harness();
    await h.submit(1, plan(h.engine, { burns: [100] }));
    await h.submit(2, plan(h.engine, { burns: [200] }));
    const pid = (await h.me(1)).body.player.pid;
    const g = (await h.store.findByPid(TEST_MISSION.id, V, pid))!;
    expect(await h.store.putEntries(withHidden(g, true, h.clock))).toBe(true);
    expect((await h.board('combined')).body.entries.map((x: { name: string }) => x.name)).toEqual(['Player 2']);
    await h.submit(1, plan(h.engine, { burns: [50] }));
    expect((await h.board('deltaV')).body.entries.map((x: { name: string }) => x.name)).toEqual(['Player 2']);
    expect((await h.me(1)).body.ranks.combined).toBeNull();
  });

  it('serves stored plans only when the deployment enables it', async () => {
    const h = new Harness();
    const p = encode(plan(h.engine, { burns: [100] }));
    await h.submit(1, p);
    const pid = (await h.me(1)).body.player.pid;
    const q = { mission: TEST_MISSION.id, version: V, board: 'deltaV', pid };
    let r = await h.call('GET', '/api/leaderboard/plan', { query: q });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('plans-not-public');
    h.setEngine(h.engine, { ...CONFIG, exposePlans: true });
    r = await h.call('GET', '/api/leaderboard/plan', { query: q });
    expect(r.body).toEqual({ pid, board: 'deltaV', site: 'all', plan: p });
    expect(JSON.stringify((await h.board('deltaV')).body)).not.toContain(p);
  });
});

describe('rate limiting', () => {
  it('limits submissions per player per window, with Retry-After, and resets in the next window', async () => {
    const h = new Harness();
    h.clock = Date.UTC(2026, 10, 26, 12, 0, 0);
    for (let i = 0; i < 6; i++) expect((await h.submit(1, plan(h.engine, { burns: [100 + i] }))).status).toBe(200);
    const r = await h.submit(1, plan(h.engine, { burns: [200] }));
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate-limited');
    expect(r.headers['retry-after']).toBe('60');
    expect((await h.submit(2, plan(h.engine, { burns: [200] }))).status).toBe(200); // other player unaffected
    h.clock += 60_000;
    expect((await h.submit(1, plan(h.engine, { burns: [200] }))).status).toBe(200);
  });

  it('limits submissions per IP across players, storing only a salted hash of the address', async () => {
    const h = new Harness();
    for (let i = 0; i < 12; i++) expect((await h.submit(i, plan(h.engine, { burns: [100 + i] }), {}, '192.0.2.77')).status).toBe(200);
    expect((await h.submit(50, plan(h.engine, { burns: [300] }), {}, '192.0.2.77')).status).toBe(429);
    expect((await h.submit(50, plan(h.engine, { burns: [300] }), {}, '192.0.2.78')).status).toBe(200);
    const dump = JSON.stringify([...h.db.items.values()]);
    expect(dump).not.toContain('192.0.2.77');
    expect([...h.db.items.keys()].filter((k) => k.startsWith('R#ip#')).every((k) => /^R#ip#[0-9a-f]{32}#/.test(k))).toBe(true);
    // Rate items expire through TTL.
    expect([...h.db.items.values()].filter((i) => (i.pk as { S: string }).S.startsWith('R#')).every((i) => 'expiresAt' in i)).toBe(true);
  });

  it('rate-limited and invalid requests never reach the replay', async () => {
    const h = new Harness({ ...CONFIG, playerLimits: [[1, 60]] });
    await h.submit(1, plan(h.engine, { burns: [100] }));
    await h.submit(1, plan(h.engine, { burns: [101] }));
    expect(h.flights).toBe(1);
  });

  it('limits own-rank lookups per IP', async () => {
    const h = new Harness({ ...CONFIG, readLimits: [[2, 60]] });
    const ip = '192.0.2.9';
    const me = () => h.call('POST', '/api/leaderboard/me', { ip, body: { missionId: TEST_MISSION.id, missionVersion: V, secret: secret(1) } });
    expect((await me()).status).toBe(200);
    expect((await me()).status).toBe(200);
    expect((await me()).status).toBe(429);
  });
});

describe('routing', () => {
  it('serves the mission list with the physics version, and splits routes between the two functions', async () => {
    const h = new Harness();
    const r = await h.call('GET', '/api/leaderboard/missions');
    expect(r.body).toEqual({ physics: { model: h.engine.model, data: h.engine.fingerprint }, missions: [{ id: TEST_MISSION.id, version: V, title: TEST_MISSION.title, sites: h.engine.mission(TEST_MISSION.id)!.sites }], exposePlans: false });
    expect(r.body.missions[0].sites.filter((x: { offered: boolean }) => x.offered).map((x: { id: string }) => x.id)).toEqual(['kourou']);
    expect((await h.call('GET', '/api/leaderboard/missions', { role: 'submit' })).status).toBe(404);
    expect((await h.call('POST', '/api/leaderboard/submit', { role: 'read', body: {} })).status).toBe(404);
    expect((await h.call('GET', '/api/leaderboard/submit')).status).toBe(405);
    expect((await h.call('GET', '/api/other')).status).toBe(404);
  });
});

describe('re-verification', () => {
  /** The same engine under a different physics build (data fingerprint). */
  const rebuilt = (e: Engine, fp: string, fly = fakeFly): Engine => {
    const fresh = createEngine({ catalogue: [TEST_MISSION], fly });
    return { ...fresh, fingerprint: fp, physicsVersion: `${e.model}.${fp}` };
  };

  it('after a physics change boards are empty until re-verified; re-verification keeps what still succeeds', async () => {
    const h = new Harness();
    await h.submit(1, plan(h.engine, { burns: [100] }));
    await h.submit(2, plan(h.engine, { burns: [200] }));
    await h.submit(3, plan(h.engine, { burns: [300] }));
    // New physics: player 2's flight no longer works, player 3's costs more.
    const fly = (p: Parameters<typeof fakeFly>[0], m: Parameters<typeof fakeFly>[1], o: Parameters<typeof fakeFly>[2]) => {
      const v = fakeFly(p, m, o);
      const dv = p.burns[0]?.duration;
      if (dv === 200) return { ...v, success: false };
      if (dv === 300) return { ...v, deltaV: v.deltaV + 5 };
      return v;
    };
    const e2 = rebuilt(h.engine, 'feedf00d', fly);
    h.setEngine(e2);
    expect((await h.board('deltaV')).body.entries).toHaveLength(0);
    // Old plans are now refused at submission (their data stamp is old).
    expect((await h.submit(9, plan(h.engine, { burns: [100], data: 'aaaaaaaa' }))).body.error).toBe('version-mismatch');

    const dry = await reverify({ engine: e2, store: h.store, mission: e2.mission(TEST_MISSION.id)!, dryRun: true });
    expect(dry.written).toBe(0);
    const s = await reverify({ engine: e2, store: h.store, mission: e2.mission(TEST_MISSION.id)! });
    expect(s).toMatchObject({ entries: 3, plansFlown: 3, written: 3 });
    const b = (await h.board('deltaV')).body.entries;
    expect(b.map((x: { name: string; deltaV: number }) => `${x.name}:${x.deltaV}`)).toEqual(['Player 1:1000', 'Player 3:3005']);
    const pid2 = (await h.me(2)).body.player.pid;
    const g2 = (await h.store.findByPid(TEST_MISSION.id, V, pid2))!;
    expect(g2.all!.slots.combined).toMatchObject({ status: 'invalid' });
    const e = g2.sites.get('kourou')!;
    expect(e.slots.combined).toMatchObject({ status: 'invalid' });
    expect(e.slots.combined!.reason).toMatch(/objectives not met/);
    // Idempotent: a second run changes nothing.
    expect(await reverify({ engine: e2, store: h.store, mission: e2.mission(TEST_MISSION.id)! })).toMatchObject({ unchanged: 3, written: 0 });
  });

  it('carries entries from an old mission version into the current one', async () => {
    const h = new Harness();
    await h.submit(1, plan(h.engine, { burns: [100] }));
    const v4 = { ...TEST_MISSION, version: 4 };
    const e4 = createEngine({ catalogue: [v4], fly: fakeFly });
    const s = await reverify({ engine: e4, store: h.store, mission: e4.mission(TEST_MISSION.id)!, from: V });
    expect(s.written).toBe(1);
    h.setEngine(e4);
    const r = await h.call('GET', '/api/leaderboard/board', { query: { mission: TEST_MISSION.id, version: '4', board: 'deltaV' } });
    expect(r.body.entries.map((x: { name: string }) => x.name)).toEqual(['Player 1']);
    // The old version's board is gone from the API (version 3 is no longer current).
    expect((await h.board('deltaV')).body.error).toBe('mission-version');
  });
});

describe('a mission version that adds a launch vehicle', () => {
  const v4 = { ...TEST_MISSION, version: 4, rules: { ...TEST_MISSION.rules, vehicle: vehicleLaunch(catalogueStages('falcon-9'), PARKING_BAND) } };

  it('refuses plans made for the previous version with the editor’s reason, and re-verification does not carry them over', async () => {
    const h = new Harness();
    const old = plan(h.engine, { burns: [100] });
    expect((await h.submit(1, old)).status).toBe(200);
    const e4 = createEngine({ catalogue: [v4], fly: fakeFly });
    const lines: string[] = [];
    const s = await reverify({ engine: e4, store: h.store, mission: e4.mission(TEST_MISSION.id)!, from: V, log: (l) => lines.push(l) });
    expect(s).toMatchObject({ entries: 1, plansFlown: 1, written: 0 });
    expect(s.slotsInvalid).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes(OLD_VERSION_MESSAGE))).toBe(true);
    h.setEngine(e4);
    const r = await h.call('GET', '/api/leaderboard/board', { query: { mission: TEST_MISSION.id, version: '4', board: 'deltaV' } });
    expect(r.body.entries).toEqual([]);
    // Submitted again under the new version: refused, with the same wording as the editor's check.
    const again = await h.call('POST', '/api/leaderboard/submit', { body: { missionId: TEST_MISSION.id, missionVersion: '4', plan: encode(old), name: 'Ada', secret: secret(1) } });
    expect(again.status).toBe(422);
    expect(again.body.error).toBe('rule-violation');
    expect(again.body.message).toBe(OLD_VERSION_MESSAGE);
    // Under its own (old) version number it is told the mission moved on.
    const stale = await h.call('POST', '/api/leaderboard/submit', { body: { missionId: TEST_MISSION.id, missionVersion: V, plan: encode(old), name: 'Ada', secret: secret(1) } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('mission-version');
  });
});

describe('launch sites: per-site and all-sites boards', () => {
  const SV = String(SITES_MISSION.version);
  const fly = (site: string, dv: number, offset = 0) => (h: Harness) => plan(h.engine, { site, burns: [dv / 10], offset });
  const rows = (r: { body: { entries: { name: string; site: string; deltaV: number; rank: number }[] } }) => r.body.entries.map((x) => `${x.rank}.${x.name}@${x.site}:${x.deltaV}`);

  it('ranks each site board and the all-sites board; a player appears once per site and once overall', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    expect((await h.submit(1, fly('kourou', 1000)(h))).body).toMatchObject({ site: 'kourou', improved: { deltaV: true }, siteImproved: { deltaV: true } });
    await h.submit(2, fly('cape-canaveral', 2000)(h));
    await h.submit(3, fly('kourou', 1500)(h));
    const two = (await h.submit(1, fly('cape-canaveral', 1200)(h))).body;
    // Player 1's Cape flight is their Cape best but not their overall best.
    expect(two).toMatchObject({ site: 'cape-canaveral', improved: { deltaV: false }, siteImproved: { deltaV: true } });
    expect(two.ranks.deltaV).toMatchObject({ rank: 1, site: 'kourou', deltaV: 1000 });
    expect(two.siteRanks.deltaV).toMatchObject({ rank: 1, site: 'cape-canaveral', deltaV: 1200 });

    expect(rows(await h.board('deltaV', 20, undefined, 'kourou'))).toEqual(['1.Player 1@kourou:1000', '2.Player 3@kourou:1500']);
    expect(rows(await h.board('deltaV', 20, undefined, 'cape-canaveral'))).toEqual(['1.Player 1@cape-canaveral:1200', '2.Player 2@cape-canaveral:2000']);
    expect(rows(await h.board('deltaV', 20, undefined, 'equator'))).toEqual([]);
    const all = await h.board('deltaV', 20, undefined, 'all');
    expect(all.body.site).toBe('all');
    expect(rows(all)).toEqual(['1.Player 1@kourou:1000', '2.Player 3@kourou:1500', '3.Player 2@cape-canaveral:2000']);
    // No `site`: the all-sites board (old clients keep working).
    expect(rows(await h.board('deltaV'))).toEqual(rows(all));
    // Every board kind is filtered the same way.
    for (const b of ['combined', 'time']) expect((await h.board(b, 20, undefined, 'cape-canaveral')).body.entries.map((x: { name: string }) => x.name).sort()).toEqual(['Player 1', 'Player 2']);
  });

  it('an improvement on one site leaves the other sites alone; a better flight elsewhere moves the all-sites best', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    await h.submit(1, fly('kourou', 1000)(h));
    const kourouAt = (await h.board('deltaV', 20, undefined, 'kourou')).body.entries[0].submittedAt;
    await h.submit(1, fly('cape-canaveral', 1300)(h));
    h.clock += 60_000;
    const better = (await h.submit(1, fly('cape-canaveral', 1100, 1)(h))).body;
    expect(better).toMatchObject({ improved: { deltaV: false }, siteImproved: { deltaV: true } });
    const k = (await h.board('deltaV', 20, undefined, 'kourou')).body.entries;
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ deltaV: 1000, site: 'kourou', submittedAt: kourouAt });
    expect(rows(await h.board('deltaV', 20, undefined, 'cape-canaveral'))).toEqual(['1.Player 1@cape-canaveral:1100']);
    // A worse flight from a site changes nothing at all (no write).
    const writes = h.db.calls.filter((c) => c.op === 'PutItem' || c.op === 'TransactWriteItems').length;
    expect((await h.submit(1, fly('kourou', 1400, 2)(h))).body).toMatchObject({ improved: { deltaV: false }, siteImproved: { deltaV: false } });
    expect(h.db.calls.filter((c) => c.op === 'TransactWriteItems').length + h.db.calls.filter((c) => c.op === 'PutItem').length - writes).toBe(1); // the score cache only
    // The equator flight beats everything: the all-sites row switches site, the site boards keep theirs.
    h.clock += 60_000;
    expect((await h.submit(1, fly('equator', 800)(h))).body).toMatchObject({ improved: { deltaV: true }, siteImproved: { deltaV: true } });
    expect(rows(await h.board('deltaV', 20, undefined, 'all'))).toEqual(['1.Player 1@equator:800']);
    expect(rows(await h.board('deltaV', 20, undefined, 'kourou'))).toEqual(['1.Player 1@kourou:1000']);
    expect((await h.me(1)).body.ranks.deltaV).toMatchObject({ rank: 1, site: 'equator', deltaV: 800 });
  });

  it('own rank for a chosen site and for all sites', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    for (let i = 1; i <= 5; i++) await h.submit(i, fly(i % 2 ? 'kourou' : 'cape-canaveral', 1000 + 100 * i)(h));
    await h.submit(5, fly('cape-canaveral', 1050)(h));
    // Player 5: kourou 1500 (3rd of 1, 3, 5), cape 1050 (1st), all 1050 @ cape (1st).
    const k = (await h.me(5, 'kourou')).body;
    expect(k).toMatchObject({ site: 'kourou', player: { name: 'Player 5' } });
    expect(k.ranks.deltaV).toMatchObject({ rank: 3, site: 'kourou', deltaV: 1500 });
    expect((await h.me(5, 'cape-canaveral')).body.ranks.deltaV).toMatchObject({ rank: 1, deltaV: 1050 });
    const a = (await h.me(5)).body;
    expect(a.site).toBe('all');
    expect(a.ranks.deltaV).toMatchObject({ rank: 1, site: 'cape-canaveral', deltaV: 1050 });
    expect((await h.me(4, 'all')).body.ranks.deltaV).toMatchObject({ rank: 5, site: 'cape-canaveral', deltaV: 1400 });
    // A site the player never flew from: a player, no ranks.
    expect((await h.me(2, 'equator')).body).toMatchObject({ player: { name: 'Player 2' }, ranks: { combined: null, deltaV: null, time: null } });
    // Bad site filters.
    expect((await h.me(5, 'tanegashima')).status).toBe(400);
    expect((await h.me(5, 'nowhere')).body.error).toBe('bad-request');
  });

  it('paginates site boards and the all-sites board with cursors', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION, pageSize: 2 });
    for (let i = 1; i <= 7; i++) {
      await h.submit(i, fly('kourou', 1000 + 10 * i)(h));
      await h.submit(i, fly('equator', 2000 + 10 * i)(h));
    }
    for (const site of ['kourou', 'equator', 'all']) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await h.board('deltaV', 3, cursor, site);
        expect(r.status).toBe(200);
        seen.push(...rows(r));
        cursor = r.body.next ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(7);
      expect(seen[0]).toBe(`1.Player 1@${site === 'equator' ? 'equator:2010' : 'kourou:1010'}`);
      expect(seen[6]).toMatch(/^7\.Player 7@/);
    }
  });

  it('refuses a flight from a site the mission does not offer, with the conformance reason, before flying it', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    const r = await h.submit(1, fly('tanegashima', 1000)(h));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('rule-violation');
    expect(r.body.message).toMatch(/tanegashima not offered for this mission: test reason/);
    expect(r.body.detail.issues.map((i: { code: string }) => i.code)).toEqual(['launch-site']);
    expect(h.flights).toBe(0);
    // Boards for that site do not exist either.
    expect((await h.board('deltaV', 20, undefined, 'tanegashima')).body).toMatchObject({ error: 'bad-request' });
    // The missions endpoint lists each site with its standing and reference values.
    const ms = (await h.call('GET', '/api/leaderboard/missions')).body.missions[0].sites;
    expect(ms.filter((s: { offered: boolean }) => s.offered).map((s: { id: string }) => s.id)).toEqual(['cape-canaveral', 'kourou', 'equator']);
    expect(ms.find((s: { id: string }) => s.id === 'kourou')).toMatchObject({ offered: true, deltaV: 1000, maxDeltaV: 5000, name: expect.stringMatching(/Kourou/) });
    expect(ms.find((s: { id: string }) => s.id === 'tanegashima')).toMatchObject({ offered: false, reason: 'test reason: no window from this site' });
  });

  it('hiding a player hides every site entry and the all-sites entry', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    await h.submit(1, fly('kourou', 1000)(h));
    await h.submit(1, fly('cape-canaveral', 1000)(h));
    await h.submit(2, fly('cape-canaveral', 1500)(h));
    const g = (await h.store.findByPid(SITES_MISSION.id, SV, (await h.me(1)).body.player.pid))!;
    expect([...g.sites.keys()].sort()).toEqual(['cape-canaveral', 'kourou']);
    expect(await h.store.putEntries(withHidden(g, true, h.clock))).toBe(true);
    for (const site of ['kourou', 'cape-canaveral', 'all']) expect((await h.board('deltaV', 20, undefined, site)).body.entries.map((x: { name: string }) => x.name)).toEqual(site === 'kourou' ? [] : ['Player 2']);
    // Submitting again from a new site keeps the player hidden there too.
    await h.submit(1, fly('equator', 500)(h));
    expect((await h.board('deltaV', 20, undefined, 'equator')).body.entries).toEqual([]);
    expect((await h.board('deltaV', 20, undefined, 'all')).body.entries.map((x: { name: string }) => x.name)).toEqual(['Player 2']);
  });

  it('a lost race on the group is retried and both flights count', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    await h.submit(1, fly('kourou', 1000)(h));
    const [a, b] = await Promise.all([h.submit(1, fly('cape-canaveral', 900)(h)), h.submit(1, fly('equator', 800)(h))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(rows(await h.board('deltaV', 20, undefined, 'all'))).toEqual(['1.Player 1@equator:800']);
    expect(rows(await h.board('deltaV', 20, undefined, 'cape-canaveral'))).toEqual(['1.Player 1@cape-canaveral:900']);
  });

  it('re-verification rebuilds site boards and recomputes the all-sites best from what still succeeds', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    await h.submit(1, fly('kourou', 1000)(h));
    await h.submit(1, fly('equator', 800)(h));
    await h.submit(2, fly('cape-canaveral', 900)(h));
    // New physics: the equator plan (8 s burn... 80 s) no longer succeeds.
    const fly2 = (p: Parameters<typeof fakeFly>[0], m: Parameters<typeof fakeFly>[1], o: Parameters<typeof fakeFly>[2]) => {
      const v = fakeFly(p, m, o);
      return p.start.kind === 'launch' && p.start.site === 'equator' ? { ...v, success: false } : v;
    };
    const fresh = createEngine({ catalogue: [SITES_MISSION], fly: fly2 });
    const e2 = { ...fresh, fingerprint: 'feedf00d', physicsVersion: `${fresh.model}.feedf00d` };
    h.setEngine(e2);
    expect((await h.board('deltaV', 20, undefined, 'all')).body.entries).toEqual([]);
    const s = await reverify({ engine: e2, store: h.store, mission: e2.mission(SITES_MISSION.id)! });
    expect(s).toMatchObject({ entries: 2, plansFlown: 3, written: 2 });
    expect(rows(await h.board('deltaV', 20, undefined, 'all'))).toEqual(['1.Player 2@cape-canaveral:900', '2.Player 1@kourou:1000']);
    expect(rows(await h.board('deltaV', 20, undefined, 'kourou'))).toEqual(['1.Player 1@kourou:1000']);
    expect(rows(await h.board('deltaV', 20, undefined, 'equator'))).toEqual([]);
    const g = (await h.store.findByPid(SITES_MISSION.id, SV, (await h.me(1)).body.player.pid))!;
    expect(g.sites.get('equator')!.slots.deltaV).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/objectives not met/) });
    expect(await reverify({ engine: e2, store: h.store, mission: e2.mission(SITES_MISSION.id)! })).toMatchObject({ unchanged: 2, written: 0 });
  });

  it('re-verification migrates entries stored before launch sites existed', async () => {
    const h = new Harness(CONFIG, { mission: SITES_MISSION });
    await h.submit(1, fly('cape-canaveral', 1000)(h));
    // Rewrite player 1 as a pre-sites entry: one item, sk P#<hash>, slots without `site`.
    const g = (await h.store.findByPid(SITES_MISSION.id, SV, (await h.me(1)).body.player.pid))!;
    const legacy = { ...g.all!, slots: Object.fromEntries(Object.entries(g.all!.slots).map(([b, s]) => [b, { ...s!, site: undefined }])) };
    for (const k of [...h.db.items.keys()]) if (k.includes('#cape-canaveral')) h.db.items.delete(k);
    expect(await h.store.putEntry(legacy)).toBe(true);
    expect((await h.board('deltaV', 20, undefined, 'all')).body.entries).toEqual([]);
    expect(await reverify({ engine: h.engine, store: h.store, mission: h.engine.mission(SITES_MISSION.id)! })).toMatchObject({ entries: 1, written: 1 });
    expect(rows(await h.board('deltaV', 20, undefined, 'all'))).toEqual(['1.Player 1@cape-canaveral:1000']);
    expect(rows(await h.board('deltaV', 20, undefined, 'cape-canaveral'))).toEqual(['1.Player 1@cape-canaveral:1000']);
  });
});
