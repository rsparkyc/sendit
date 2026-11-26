/**
 * Leaderboard request handling, independent of Lambda: each route takes the
 * parsed request and returns status + JSON. Dependencies (engine, store,
 * clock) are injected so tests can run it end to end in memory.
 *
 * SUBMIT ORDER (cheapest first; nothing expensive before the plan is known to be acceptable):
 *  1. shape: exactly the five string fields (a `score` or any other field is refused)
 *  2. secret format, name cleanup / filter
 *  3. mission id and version
 *  4. strict plan decode + launch validation (bounded by the plan layer's limits)
 *  5. physics version of the plan (model, data fingerprint)
 *  6. leaderboard rules (start kind, sites, dates, duration, tolerance, spacecraft)
 *  7. rate limits, per player and per IP (one DynamoDB write per window)
 *  8. score cache: this exact plan under this physics and mission version already flown?
 *  9. replay + objectives within the wall-clock and step budgets (cached unless it timed out)
 * 10. update the player's entry: each board keeps its own best
 */
import type { BoardEntry, BoardId, BoardResponse, ErrorCode, ErrorResponse, MeResponse, MissionsResponse, PlanResponse, RankInfo, SubmitResponse } from '../../src/leaderboard/api';
import type { Config } from './config';
import { PlanError, SCORE_HIGHER_IS_BETTER, type Engine, type MissionInfo, type MissionPlan, type Verdict } from './engine';
import { sha256Hex } from './hash';
import { ipHashOf, pidOf, playerHashOf, tagOf, validSecret } from './identity';
import { better, BOARDS, sortKey, type Values } from './keys';
import { blocklistFilter, RESERVED_TERMS, sanitizeName, type NameFilter } from './names';
import { boardPk, type CachedVerdict, type Entry, type Slot, type Store } from './store';

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  /** Seconds a shared cache may keep it (0: no-store). */
  readonly cache?: number;
  readonly retryAfter?: number;
}

export interface Deps {
  readonly engine: Engine;
  readonly store: Store;
  readonly config: Config;
  readonly now?: () => number;
  /** Name filter; default: reserved terms plus config.nameBlocklist. */
  readonly nameFilter?: NameFilter;
}

const STATUS: Record<ErrorCode, number> = {
  'bad-request': 400,
  'unexpected-field': 400,
  'bad-secret': 400,
  'bad-name': 400,
  'name-rejected': 422,
  'body-too-large': 413,
  'not-found': 404,
  'method-not-allowed': 405,
  'unknown-mission': 404,
  'mission-version': 409,
  'version-mismatch': 409,
  'invalid-plan': 422,
  'rule-violation': 422,
  'objectives-not-met': 422,
  'replay-limit': 422,
  'rate-limited': 429,
  'replay-timeout': 503,
  'plans-not-public': 403,
  'server-error': 500,
};

export function fail(error: ErrorCode, message: string, detail?: unknown, retryAfter?: number): Reply {
  const body: ErrorResponse = { error, message, ...(detail === undefined ? {} : { detail }), ...(retryAfter === undefined ? {} : { retryAfter }) };
  return { status: STATUS[error], body, retryAfter };
}

const SUBMIT_FIELDS = ['missionId', 'missionVersion', 'plan', 'name', 'secret'] as const;
const ME_FIELDS = ['missionId', 'missionVersion', 'secret'] as const;

/** Exactly these string fields, nothing else. */
function fields<K extends string>(body: unknown, keys: readonly K[]): Record<K, string> | Reply {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('bad-request', 'body must be a JSON object');
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!(keys as readonly string[]).includes(k)) return fail('unexpected-field', `unexpected field "${k.slice(0, 40)}": the server computes every result itself`);
  }
  // Mission versions are strings on the wire ("1", as /missions returns them); a non-negative integer is accepted too.
  const v = o.missionVersion;
  const norm = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? { ...o, missionVersion: String(v) } : o;
  for (const k of keys) if (typeof norm[k] !== 'string') return fail('bad-request', `field "${k}" must be a string`);
  return norm as Record<K, string>;
}

const isReply = (x: unknown): x is Reply => typeof x === 'object' && x !== null && 'status' in x && 'body' in x;

export class Service {
  private readonly now: () => number;
  private readonly filter: NameFilter;

  constructor(private readonly d: Deps) {
    this.now = d.now ?? Date.now;
    this.filter = d.nameFilter ?? blocklistFilter([...RESERVED_TERMS, ...d.config.nameBlocklist]);
  }

  private missionAt(id: string, version: string): MissionInfo | Reply {
    const m = this.d.engine.mission(id);
    if (!m) return fail('unknown-mission', `no mission "${id.slice(0, 40)}"`);
    if (m.version !== version) return fail('mission-version', `mission "${id}" is now version ${m.version}; your plan was made for version ${version.slice(0, 32)}. Reload to get the current mission.`, { current: m.version });
    return m;
  }

  missions(): Reply {
    const e = this.d.engine;
    const body: MissionsResponse = {
      physics: { model: e.model, data: e.fingerprint },
      missions: e.missions().map((m) => ({ id: m.id, version: m.version, title: m.title })),
      exposePlans: this.d.config.exposePlans,
    };
    return { status: 200, body, cache: 60 };
  }

  // ------------------------------------------------------------------ submit

  async submit(body: unknown, ip: string): Promise<Reply> {
    const { engine, store, config } = this.d;
    const f = fields(body, SUBMIT_FIELDS);
    if (isReply(f)) return f;
    if (!validSecret(f.secret)) return fail('bad-secret', 'secret must be 43-64 base64url characters');
    const name = sanitizeName(f.name, this.filter);
    if (!name.ok) return fail(name.code, name.message);
    const m = this.missionAt(f.missionId, f.missionVersion);
    if (isReply(m)) return m;

    let plan: MissionPlan;
    try {
      plan = engine.decode(f.plan);
    } catch (e) {
      if (e instanceof PlanError) return fail('invalid-plan', e.message);
      throw e;
    }
    if (plan.model !== engine.model || plan.data !== engine.fingerprint) {
      return fail(
        'version-mismatch',
        `this plan was made with physics model ${plan.model} / data ${plan.data}; the leaderboard runs model ${engine.model} / data ${engine.fingerprint}. Reload the game and fly it again.`,
        { expected: { model: engine.model, data: engine.fingerprint }, got: { model: plan.model, data: plan.data } },
      );
    }
    const issues = engine.checkRules(plan, m);
    if (issues.length > 0) return fail('rule-violation', issues.map((i) => i.message).join('; '), { issues });

    const now = this.now();
    const playerHash = await playerHashOf(f.secret);
    const ipHash = await ipHashOf(ip, config.ipSalt, now);
    for (const [limit, win] of config.playerLimits) {
      if (!(await store.hit(`p#${playerHash}`, limit, win, now))) return fail('rate-limited', `at most ${limit} submissions per ${win} s per player`, undefined, win - (Math.floor(now / 1000) % win));
    }
    for (const [limit, win] of config.ipLimits) {
      if (!(await store.hit(`ip#${ipHash}`, limit, win, now))) return fail('rate-limited', `at most ${limit} submissions per ${win} s from one address`, undefined, win - (Math.floor(now / 1000) % win));
    }

    const planHash = await sha256Hex(f.plan);
    const cacheKey = await sha256Hex(`v1|${engine.physicsVersion}|${m.id}|${m.version}|${f.plan}`);
    let v: CachedVerdict | null = await store.getCached(cacheKey);
    if (!v) {
      const verdict: Verdict = engine.verify(plan, m, { deadline: Date.now() + config.replayBudgetMs, maxSteps: config.maxSteps }); // real wall clock, not the injectable `now`
      if (verdict.status === 'timeout') {
        // Not cached: wall-clock time depends on the instance (cold chunks), the plan may fit next time.
        return fail('replay-timeout', `the server could not finish flying this plan within ${config.replayBudgetMs / 1000} s; try again shortly`, undefined, 30);
      }
      v = { status: verdict.status, success: verdict.success, score: verdict.score, deltaV: verdict.deltaV, missionTime: verdict.missionTime, digest: verdict.digest, outcome: verdict.outcome, reason: verdict.reason, objectives: verdict.objectives };
      await store.putCached(cacheKey, v, now);
    }
    if (v.status === 'limit') return fail('replay-limit', `the flight is too expensive to verify: ${v.reason}`);
    if (v.status === 'invalid') return fail('invalid-plan', v.reason);
    if (v.status === 'error') return fail('invalid-plan', `the physics refused this plan: ${v.reason}`);
    if (!v.success) return fail('objectives-not-met', 'the flight does not complete the mission', { outcome: v.outcome, reason: v.reason, objectives: v.objectives, digest: v.digest });

    const values: Values = { score: v.score, deltaV: v.deltaV, missionTime: v.missionTime };
    const tag = await tagOf(playerHash);
    const improved: Record<BoardId, boolean> = { combined: false, deltaV: false, time: false };
    let entry: Entry | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await store.getEntry(m.id, m.version, playerHash);
      const slots = { ...(old?.slots ?? {}) };
      const plans = { ...(old?.plans ?? {}) };
      for (const b of BOARDS) {
        const cur = slots[b];
        const replace = !cur || cur.status !== 'valid' || cur.physics !== engine.physicsVersion || better(b, values, cur, SCORE_HIGHER_IS_BETTER);
        improved[b] = replace;
        if (replace) {
          slots[b] = { ...values, at: now, digest: v.digest, planHash, physics: engine.physicsVersion, status: 'valid', key: sortKey(b, values, now, playerHash, SCORE_HIGHER_IS_BETTER) };
          plans[b] = f.plan;
        }
      }
      const next: Entry = {
        mission: m.id,
        version: m.version,
        playerHash,
        pid: pidOf(playerHash),
        name: name.name,
        tag,
        hidden: old?.hidden ?? false,
        created: old?.created ?? now,
        updated: now,
        rev: old?.rev ?? 0,
        slots,
        plans,
      };
      if (await store.putEntry(next)) {
        entry = { ...next, rev: next.rev + 1 };
        break;
      }
    }
    if (!entry) return fail('server-error', 'too many concurrent updates to this entry; try again');

    const res: SubmitResponse = {
      mission: m.id,
      version: m.version,
      result: { ...values, digest: v.digest },
      improved,
      player: { name: entry.name, tag, pid: entry.pid },
      ranks: await this.ranksOf(entry),
    };
    return { status: 200, body: res };
  }

  private async ranksOf(e: Entry): Promise<Record<BoardId, RankInfo | null>> {
    const out: Record<BoardId, RankInfo | null> = { combined: null, deltaV: null, time: null };
    if (e.hidden) return out;
    const physics = this.d.engine.physicsVersion;
    for (const b of BOARDS) {
      const s = e.slots[b];
      if (!s || s.status !== 'valid' || s.physics !== physics) continue;
      const n = await this.d.store.countAbove(b, boardPk(e.mission, e.version, physics), s.key, this.d.config.maxRankCount);
      out[b] = { ...valuesOf(s), submittedAt: iso(s.at), rank: n === null ? null : n + 1, ...(n === null ? { beyond: this.d.config.maxRankCount } : {}) };
    }
    return out;
  }

  // ---------------------------------------------------------------------- me

  async me(body: unknown, ip: string): Promise<Reply> {
    const f = fields(body, ME_FIELDS);
    if (isReply(f)) return f;
    if (!validSecret(f.secret)) return fail('bad-secret', 'secret must be 43-64 base64url characters');
    const m = this.missionAt(f.missionId, f.missionVersion);
    if (isReply(m)) return m;
    // Own-rank counting costs reads proportional to the rank: bounded per address.
    const now = this.now();
    const ipHash = await ipHashOf(ip, this.d.config.ipSalt, now);
    for (const [limit, win] of this.d.config.readLimits) {
      if (!(await this.d.store.hit(`me#${ipHash}`, limit, win, now))) return fail('rate-limited', `at most ${limit} rank lookups per ${win} s from one address`, undefined, win - (Math.floor(now / 1000) % win));
    }
    const e = await this.d.store.getEntry(m.id, m.version, await playerHashOf(f.secret));
    const res: MeResponse = {
      mission: m.id,
      version: m.version,
      player: e ? { name: e.name, tag: e.tag, pid: e.pid } : null,
      ranks: e ? await this.ranksOf(e) : { combined: null, deltaV: null, time: null },
    };
    return { status: 200, body: res };
  }

  // ------------------------------------------------------------------- board

  async board(q: Readonly<Record<string, string | undefined>>): Promise<Reply> {
    const m = this.missionAt(q.mission ?? '', q.version ?? '');
    if (isReply(m)) return m;
    const board = q.board ?? 'combined';
    if (!(BOARDS as readonly string[]).includes(board)) return fail('bad-request', `board must be one of ${BOARDS.join(', ')}`);
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.d.config.maxBoardLimit) return fail('bad-request', `limit must be 1-${this.d.config.maxBoardLimit}`);
    let after: { k: string; r: number } | undefined;
    if (q.cursor) {
      after = decodeCursor(q.cursor);
      if (!after) return fail('bad-request', 'bad cursor');
    }
    const b = board as BoardId;
    const rows = await this.d.store.board(b, boardPk(m.id, m.version, this.d.engine.physicsVersion), limit, after?.k);
    const base = after?.r ?? 0;
    const entries: BoardEntry[] = rows.map((r, i) => ({ rank: base + i + 1, pid: r.pid, name: r.name, tag: r.tag, score: r.values.score, deltaV: r.values.deltaV, missionTime: r.values.missionTime, submittedAt: iso(r.values.at) }));
    const last = rows[rows.length - 1];
    const res: BoardResponse = { mission: m.id, version: m.version, board: b, entries, next: rows.length === limit && last ? encodeCursor(last.key, base + rows.length) : null };
    return { status: 200, body: res, cache: 10 };
  }

  // -------------------------------------------------------------------- plan

  async plan(q: Readonly<Record<string, string | undefined>>): Promise<Reply> {
    if (!this.d.config.exposePlans) return fail('plans-not-public', 'this leaderboard does not publish flight plans');
    const m = this.missionAt(q.mission ?? '', q.version ?? '');
    if (isReply(m)) return m;
    const board = (q.board ?? 'combined') as BoardId;
    if (!BOARDS.includes(board)) return fail('bad-request', `board must be one of ${BOARDS.join(', ')}`);
    if (!/^[0-9a-f]{16}$/.test(q.pid ?? '')) return fail('bad-request', 'pid must be 16 hex digits');
    const e = await this.d.store.findByPid(m.id, m.version, q.pid!);
    const s = e?.slots[board];
    const plan = e?.plans[board];
    if (!e || e.hidden || !s || s.status !== 'valid' || s.physics !== this.d.engine.physicsVersion || !plan) return fail('not-found', 'no such entry');
    const res: PlanResponse = { pid: e.pid, board, plan };
    return { status: 200, body: res, cache: 60 };
  }
}

function valuesOf(s: Slot): { score: number; deltaV: number; missionTime: number } {
  return { score: s.score, deltaV: s.deltaV, missionTime: s.missionTime };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function encodeCursor(k: string, r: number): string {
  return `${r}.${k}`;
}

function decodeCursor(c: string): { k: string; r: number } | undefined {
  const m = /^(\d{1,9})\.([0-9a-f]{61,200})$/.exec(c);
  return m ? { r: Number(m[1]), k: m[2] } : undefined;
}
