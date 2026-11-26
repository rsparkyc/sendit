/** Deployment settings, from environment variables (set by infra/leaderboard.yaml). */

export interface Config {
  readonly table: string;
  readonly region: string;
  /** Secret salt for IP hashing. */
  readonly ipSalt: string;
  /** Whether stored plans may be fetched by other players (product decision; default false). */
  readonly exposePlans: boolean;
  /** Largest request body accepted, bytes. */
  readonly maxBodyBytes: number;
  /** Wall-clock budget for ephemeris building + replay of one submission, ms. */
  readonly replayBudgetMs: number;
  /** Integrator step budget per replay. */
  readonly maxSteps: number;
  /** Board page size cap. */
  readonly maxBoardLimit: number;
  /** Own-rank lookups count at most this many rows above (rank reported as "beyond" past it). */
  readonly maxRankCount: number;
  /** Submissions per window: [limit, window seconds] per player and per IP. */
  readonly playerLimits: readonly (readonly [number, number])[];
  readonly ipLimits: readonly (readonly [number, number])[];
  /** Own-rank lookups (/me) per window per IP. */
  readonly readLimits: readonly (readonly [number, number])[];
  /** Extra blocked name terms (the reserved list always applies). */
  readonly nameBlocklist: readonly string[];
}

function int(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}

/** "6/60,40/3600" -> [[6, 60], [40, 3600]] */
export function parseLimits(v: string | undefined, d: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  if (!v) return d;
  const out: [number, number][] = [];
  for (const part of v.split(',')) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(part);
    if (!m) throw new Error(`bad rate limit "${part}" (expected count/seconds)`);
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): Config {
  const table = env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const ipSalt = env.IP_HASH_SALT ?? '';
  if (ipSalt.length < 16) throw new Error('IP_HASH_SALT must be at least 16 characters');
  return {
    table,
    region: env.AWS_REGION ?? 'us-east-1',
    ipSalt,
    exposePlans: env.EXPOSE_PLANS === 'true',
    maxBodyBytes: int(env.MAX_BODY_BYTES, 20_000),
    replayBudgetMs: int(env.REPLAY_BUDGET_MS, 30_000),
    maxSteps: int(env.MAX_STEPS, 100_000),
    maxBoardLimit: 100,
    maxRankCount: int(env.MAX_RANK_COUNT, 10_000),
    playerLimits: parseLimits(env.PLAYER_RATE_LIMITS, [[6, 60], [60, 3600]]),
    ipLimits: parseLimits(env.IP_RATE_LIMITS, [[12, 60], [120, 3600]]),
    readLimits: parseLimits(env.ME_RATE_LIMITS, [[30, 60], [300, 3600]]),
    nameBlocklist: (env.NAME_BLOCKLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
