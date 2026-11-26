/**
 * Test harness: the real HTTP layer, service, store, plan decoder and rules
 * over the in-memory DynamoDB fake, with the replay replaced by a fast
 * stand-in (`fakeFly`) so ranking and abuse tests run in milliseconds. The
 * real replay is exercised separately (engine.test.ts).
 */
import type { Config } from './config';
import { createEngine, type Engine, type MissionInfo, type Verdict, type VerifyOptions } from './engine';
import { FakeDynamo, LEADERBOARD_INDEXES } from './fake-dynamo';
import { handle, type Role, type UrlResponse } from './http';
import { Service } from './service';
import { Store } from './store';
import { launchToParams } from '../../src/mission/launch';
import { encodePlan, makePlan, type MissionPlan, type PlanBurn } from '../../src/mission/plan';
import type { MissionDefinition } from '../../src/mission/objectives';

const DAY = 86400;
export const T0 = (Date.UTC(2027, 0, 10, 12) - Date.UTC(2000, 0, 1, 12)) / 1000 + 69.184;
export const CRAFT = { wetMass: 30000, dryMass: 12000, engines: [{ thrust: 200e3, isp: 450 }] };

/** A versioned mission with the rule fields the campaign uses. */
export const TEST_MISSION: MissionDefinition = {
  id: 'test-mission',
  title: 'Test mission',
  version: 3,
  objectives: [{ kind: 'flyby', body: 'moon', minAltitude: 100e3 }, { kind: 'max-time', max: 10 * DAY }],
  scoring: { deltaVRef: 3000, deltaVWeight: 1, timeRef: 5 * DAY, timeWeight: 1 },
  epoch: T0,
  start: { kind: 'launch', site: 'kourou', azimuthDeg: 90, altitudeM: 200e3 },
  rules: { launchOnly: true, sites: ['kourou'], window: [T0, T0 + 30 * DAY] },
  spacecraft: CRAFT,
  maxDuration: 10 * DAY,
};

/**
 * A mission offered from several launch sites (as the campaign's are), one
 * site not offered with a reason, and per-site limits.
 */
export const SITES_MISSION: MissionDefinition = {
  ...TEST_MISSION,
  id: 'sites-mission',
  title: 'Sites mission',
  version: 1,
  rules: { launchOnly: true, sites: ['kourou', 'cape-canaveral', 'equator'], window: [T0, T0 + 30 * DAY] },
  launchSites: [
    { site: 'kourou', offered: true, deltaV: 1000, time: 5 * DAY, maxDeltaV: 5000, maxTime: 10 * DAY },
    { site: 'cape-canaveral', offered: true, deltaV: 1100, time: 5 * DAY, maxDeltaV: 5000, maxTime: 10 * DAY },
    { site: 'equator', offered: true, deltaV: 900, time: 5 * DAY, maxDeltaV: 5000, maxTime: 10 * DAY },
    { site: 'tanegashima', offered: false, reason: 'test reason: no window from this site' },
  ],
};

export interface PlanSpec {
  /** Burn durations, s (the fake: delta-v = 10 x total burn time). */
  burns?: number[];
  /** Mission time for the fake = duration. */
  duration?: number;
  /** Launch time offset from T0, s (makes plans distinct without changing values). */
  offset?: number;
  data?: string;
  site?: string;
  craft?: MissionPlan['spacecraft'];
  rtol?: number;
}

export function plan(engine: Engine, s: PlanSpec = {}): MissionPlan {
  const t = T0 + (s.offset ?? 0);
  const site = s.site ?? 'kourou';
  const burns: PlanBurn[] = [];
  let at = 3000;
  for (const d of s.burns ?? [100]) {
    burns.push({ start: at, duration: d, engine: 0, direction: [1, 0, 0], frame: { kind: 'orbital', body: 'earth' } });
    at += d + 1000;
  }
  return makePlan({
    data: s.data ?? engine.fingerprint,
    epoch: t,
    duration: s.duration ?? 5 * DAY,
    rtol: s.rtol ?? 1e-10,
    start: { kind: 'launch', site, params: launchToParams({ mode: 'parking-orbit', siteId: site, launchTime: t, azimuthDeg: 90, altitudeM: 200e3 }) },
    spacecraft: s.craft ?? CRAFT,
    burns,
  });
}

export const encode = encodePlan;

/**
 * Stand-in for the replay: success iff the plan has burns; delta-v = 10 x
 * total burn time; mission time = duration; score from the mission layer's
 * formula shape (higher is better).
 */
export function fakeFly(p: MissionPlan, _m: MissionInfo, _o: VerifyOptions): Verdict {
  const dv = p.burns.reduce((a, b) => a + b.duration, 0) * 10;
  const t = p.duration;
  const ok = p.burns.length > 0;
  return {
    status: 'ok',
    success: ok,
    score: ok ? Math.floor(10_000 / ((dv / 3000 + t / (5 * DAY)) / 2)) : 0,
    deltaV: dv,
    missionTime: t,
    digest: (p.epoch * 1000 + dv).toString(16).padStart(16, '0').slice(-16),
    outcome: 'completed',
    reason: '',
    objectives: [{ kind: 'flyby', ok, detail: ok ? 'closest approach 500 km' : 'no close approach to moon' }],
    ms: 1,
    steps: 10,
  };
}

export const CONFIG: Config = {
  table: 'test',
  region: 'us-east-1',
  ipSalt: 'test-salt-0123456789',
  exposePlans: false,
  maxBodyBytes: 20_000,
  replayBudgetMs: 30_000,
  maxSteps: 250_000,
  maxBoardLimit: 100,
  maxRankCount: 10_000,
  playerLimits: [[6, 60], [60, 3600]],
  ipLimits: [[12, 60], [120, 3600]],
  readLimits: [[30, 60]],
  nameBlocklist: ['badword'],
};

export function secret(i: number): string {
  return `player${i}`.padEnd(43, 'x');
}

export class Harness {
  readonly db: FakeDynamo;
  readonly store: Store;
  service!: Service;
  engine!: Engine;
  clock = Date.UTC(2026, 10, 26, 12);
  flights = 0;
  ipCounter = 0;

  readonly mission: MissionDefinition;

  constructor(
    public config: Config = CONFIG,
    opts: { pageSize?: number; fly?: typeof fakeFly; engine?: Engine; mission?: MissionDefinition } = {},
  ) {
    this.db = new FakeDynamo(LEADERBOARD_INDEXES, opts.pageSize);
    this.store = new Store(this.db, config.table);
    this.mission = opts.mission ?? TEST_MISSION;
    const fly = opts.fly ?? fakeFly;
    this.setEngine(opts.engine ?? createEngine({ catalogue: [this.mission], fly: (p, m, o) => { this.flights++; return fly(p, m, o); } }));
  }

  setEngine(engine: Engine, config: Config = this.config): void {
    this.engine = engine;
    this.config = config;
    this.service = new Service({ engine, store: this.store, config, now: () => this.clock });
  }

  async call(method: string, path: string, opts: { body?: unknown; raw?: string; query?: Record<string, string>; ip?: string; headers?: Record<string, string>; role?: Role } = {}): Promise<{ status: number; body: any; headers: Record<string, string> }> {
    const raw = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const res: UrlResponse = await handle(
      this.service,
      {
        rawPath: path,
        headers: { 'cloudfront-viewer-address': `${opts.ip ?? `203.0.113.${(this.ipCounter++ % 250) + 1}`}:4431`, ...(opts.headers ?? {}) },
        queryStringParameters: opts.query,
        body: raw,
        isBase64Encoded: false,
        requestContext: { http: { method, sourceIp: '198.51.100.1' } },
      },
      this.config.maxBodyBytes,
      () => {},
      opts.role,
    );
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  }

  submit(player: number, p: MissionPlan | string, extra: Record<string, unknown> = {}, ip?: string) {
    return this.call('POST', '/api/leaderboard/submit', {
      ip,
      body: { missionId: this.mission.id, missionVersion: String(this.mission.version), plan: typeof p === 'string' ? p : encodePlan(p), name: `Player ${player}`, secret: secret(player), ...extra },
    });
  }

  board(board: string, limit = 20, cursor?: string, site?: string) {
    return this.call('GET', '/api/leaderboard/board', { query: { mission: this.mission.id, version: String(this.mission.version), board, limit: String(limit), ...(cursor ? { cursor } : {}), ...(site ? { site } : {}) } });
  }

  me(player: number, site?: string) {
    return this.call('POST', '/api/leaderboard/me', { body: { missionId: this.mission.id, missionVersion: String(this.mission.version), secret: secret(player), ...(site ? { site } : {}) } });
  }
}
