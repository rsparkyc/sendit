/**
 * Browser client for the leaderboard API (src/leaderboard/api.ts). No UI.
 *
 * LOAD IT LAZILY. Nothing in the page imports this module statically; the UI
 * should do `const lb = await import('../leaderboard/client')` when the player
 * opens a leaderboard or submits, so it adds nothing to the initial bundle.
 * It imports only types and the ALL_SITES constant from api.ts.
 *
 * LAUNCH SITES. Board, own-rank and plan calls take `site`: a launch-site id the
 * mission offers (getMissions: missions[].sites) or ALL_SITES ('all', the
 * default, as before sites existed). Every row and rank carries its `site`.
 *
 * PLAYER SECRET. The first call that needs it makes 32 random bytes
 * (crypto.getRandomValues), stores them base64url-encoded in localStorage
 * under SECRET_KEY, and sends them with submissions and own-rank lookups.
 * Whoever holds the secret is that player: `exportSecret` / `importSecret`
 * let the UI offer moving it to another browser. If storage is unavailable
 * (private mode, blocked), a per-page-load secret is used and
 * `secretIsPersistent()` is false, so the UI can warn.
 *
 * ERRORS. Every failure is a LeaderboardError with a `code` (the server's
 * ErrorCode, or 'network' / 'bad-response'), the HTTP status, the server's
 * message (fit to show) and its detail. `isVersionMismatch(e)` is true when
 * the plan or mission is out of date with the server (reload and fly again).
 *
 * RETRIES. Network errors, 5xx (including replay-timeout, after its
 * Retry-After) and 429 with a short Retry-After are retried up to `retries`
 * times with backoff. Submitting is idempotent on the server (same plan,
 * same result, one entry per player), so a retried submission is safe.
 *
 * VERSIONS. Mission versions travel as strings ("1", as getMissions returns
 * them); the functions also take a number (a definition's `version`) and send
 * it as a string.
 *
 * SAME ORIGIN. Requests go to /api/leaderboard on the page's own origin
 * (CloudFront routes /api/* to the functions). POST bodies carry their
 * SHA-256 in x-amz-content-sha256, which CloudFront's origin access control
 * needs to sign requests to Lambda function URLs.
 */
import type {
  SiteFilter,
  BoardId,
  BoardResponse,
  ErrorCode,
  ErrorResponse,
  MeRequest,
  MeResponse,
  MissionsResponse,
  PlanResponse,
  SubmitRequest,
  SubmitResponse,
} from './api';

export type { BoardEntry, BoardId, BoardResponse, MeResponse, MissionSite, MissionsResponse, RankInfo, SiteFilter, SubmitResponse, Values } from './api';
export { ALL_SITES } from './api';

export const SECRET_KEY = 'sendit.leaderboard.secret.v1';

export type ClientErrorCode = ErrorCode | 'network' | 'bad-response' | 'aborted';

export class LeaderboardError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number,
    readonly detail?: unknown,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'LeaderboardError';
  }
}

/** True if the server refused because the plan or the mission definition is out of date. */
export function isVersionMismatch(e: unknown): e is LeaderboardError {
  return e instanceof LeaderboardError && (e.code === 'version-mismatch' || e.code === 'mission-version');
}

export interface ClientOptions {
  /** Default '/api/leaderboard' (same origin). */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Default: window.localStorage when available. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Retries after the first attempt. Default 2. */
  readonly retries?: number;
  /** Longest Retry-After honoured automatically, s. Default 30. */
  readonly maxRetryAfter?: number;
  /** Per-attempt timeouts, ms. */
  readonly submitTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  /** Sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

let opts: ClientOptions = {};
let memorySecret: string | null = null;

/** Override defaults (tests, or another base URL). Merges with earlier settings. */
export function configure(o: ClientOptions): void {
  opts = { ...opts, ...o };
}

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (opts.storage !== undefined) return opts.storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SECRET_RE = /^[A-Za-z0-9_-]{43,64}$/;

/** The player's secret, created on first use. */
export function playerSecret(): string {
  const st = storage();
  try {
    const s = st?.getItem(SECRET_KEY);
    if (s && SECRET_RE.test(s)) return s;
  } catch {
    /* storage blocked: fall through */
  }
  if (memorySecret) {
    try {
      st?.setItem(SECRET_KEY, memorySecret);
    } catch {
      /* still not persistent */
    }
    return memorySecret;
  }
  const s = base64url(crypto.getRandomValues(new Uint8Array(32)));
  memorySecret = s;
  try {
    st?.setItem(SECRET_KEY, s);
  } catch {
    /* not persistent */
  }
  return s;
}

/** False if the secret could not be saved (the player would get a new identity next visit). */
export function secretIsPersistent(): boolean {
  try {
    return storage()?.getItem(SECRET_KEY) === playerSecret();
  } catch {
    return false;
  }
}

/** The secret, for the player to copy to another browser. Treat it like a password. */
export function exportSecret(): string {
  return playerSecret();
}

/** Adopt a secret exported elsewhere. Returns false if it is not a valid secret. */
export function importSecret(s: string): boolean {
  const t = s.trim();
  if (!SECRET_RE.test(t)) return false;
  memorySecret = t;
  try {
    storage()?.setItem(SECRET_KEY, t);
  } catch {
    /* kept in memory only */
  }
  return true;
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let h = '';
  for (const b of d) h += b.toString(16).padStart(2, '0');
  return h;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Req {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

async function request<T>(r: Req): Promise<T> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepDefault;
  const retries = opts.retries ?? 2;
  const maxRetryAfter = opts.maxRetryAfter ?? 30;
  const qs = r.query ? Object.entries(r.query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  const url = `${opts.baseUrl ?? '/api/leaderboard'}${r.path}${qs ? `?${qs}` : ''}`;
  const body = r.body === undefined ? undefined : JSON.stringify(r.body);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-amz-content-sha256'] = await sha256Hex(body);
  }

  let last: LeaderboardError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (r.signal?.aborted) throw new LeaderboardError('aborted', 'cancelled', 0);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    r.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), r.timeoutMs);
    let res: Response;
    try {
      res = await f(url, { method: r.method, headers, body, signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      last = new LeaderboardError(r.signal?.aborted ? 'aborted' : 'network', r.signal?.aborted ? 'cancelled' : `could not reach the leaderboard (${(e as Error).message})`, 0);
      if (r.signal?.aborted) throw last;
      if (attempt < retries) await sleep(backoffMs(attempt));
      continue;
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok) {
      if (json === null || typeof json !== 'object') throw new LeaderboardError('bad-response', 'the leaderboard sent an unreadable response', res.status);
      return json as T;
    }
    const err = json as Partial<ErrorResponse> | null;
    const retryAfter = err?.retryAfter ?? (Number(res.headers.get('retry-after')) || undefined);
    last = new LeaderboardError(err?.error ?? 'bad-response', err?.message ?? `HTTP ${res.status}`, res.status, err?.detail, retryAfter);
    const retryable = res.status >= 500 || (res.status === 429 && retryAfter !== undefined && retryAfter <= 5);
    if (!retryable || attempt >= retries) throw last;
    if (retryAfter !== undefined && retryAfter > maxRetryAfter) throw last;
    await sleep(retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt));
  }
  throw last ?? new LeaderboardError('network', 'could not reach the leaderboard', 0);
}

function backoffMs(attempt: number): number {
  return Math.round(500 * 2 ** attempt * (0.5 + Math.random()));
}

// -------------------------------------------------------------------- calls

let missionsCache: { at: number; value: Promise<MissionsResponse> } | null = null;

/** Missions on the leaderboard with their current versions, and the physics a plan must be made with. Cached 60 s. */
export function getMissions(o: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<MissionsResponse> {
  if (!o.fresh && missionsCache && Date.now() - missionsCache.at < 60_000) return missionsCache.value;
  const value = request<MissionsResponse>({ method: 'GET', path: '/missions', signal: o.signal, timeoutMs: opts.readTimeoutMs ?? 10_000 });
  missionsCache = { at: Date.now(), value };
  value.catch(() => { missionsCache = null; });
  return value;
}

/**
 * Why a plan / mission would be refused as out of date, or null if it matches
 * the server (a cheap check before submitting; the server checks again).
 */
export async function checkCompatible(missionId: string, missionVersion: string | number, plan: { model: number; data: string }, o: { signal?: AbortSignal } = {}): Promise<string | null> {
  const m = await getMissions(o);
  if (plan.model !== m.physics.model || plan.data !== m.physics.data) return 'This game version is out of date with the leaderboard. Reload the page and fly the plan again.';
  const cur = m.missions.find((x) => x.id === missionId);
  if (!cur) return 'This mission has no leaderboard.';
  if (cur.version !== String(missionVersion)) return 'This mission has been updated. Reload the page to get the new version.';
  return null;
}

/** Submit a flight. The server re-flies the plan and computes the result itself. */
export function submitFlight(s: Omit<SubmitRequest, 'secret' | 'missionVersion'> & { readonly missionVersion: string | number }, o: { signal?: AbortSignal } = {}): Promise<SubmitResponse> {
  const body: SubmitRequest = { missionId: s.missionId, missionVersion: String(s.missionVersion), plan: s.plan, name: s.name, secret: playerSecret() };
  return request<SubmitResponse>({ method: 'POST', path: '/submit', body, signal: o.signal, timeoutMs: opts.submitTimeoutMs ?? 60_000 });
}

/** One page of a board, best first. */
export function getBoard(missionId: string, missionVersion: string | number, board: BoardId, o: { site?: SiteFilter; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<BoardResponse> {
  return request<BoardResponse>({
    method: 'GET',
    path: '/board',
    query: { mission: missionId, version: String(missionVersion), board, site: o.site, limit: o.limit, cursor: o.cursor },
    signal: o.signal,
    timeoutMs: opts.readTimeoutMs ?? 10_000,
  });
}

/** This player's entry and rank on each board of a mission version, for one site or all sites (default); works far outside the top N. */
export function getMyRanks(missionId: string, missionVersion: string | number, o: { site?: SiteFilter; signal?: AbortSignal } = {}): Promise<MeResponse> {
  const body: MeRequest = { missionId, missionVersion: String(missionVersion), secret: playerSecret(), ...(o.site !== undefined ? { site: o.site } : {}) };
  return request<MeResponse>({ method: 'POST', path: '/me', body, signal: o.signal, timeoutMs: opts.readTimeoutMs ?? 10_000 });
}

/** A stored plan, only if the deployment publishes plans (else LeaderboardError 'plans-not-public'). */
export function getPlan(missionId: string, missionVersion: string | number, board: BoardId, pid: string, o: { site?: SiteFilter; signal?: AbortSignal } = {}): Promise<PlanResponse> {
  return request<PlanResponse>({ method: 'GET', path: '/plan', query: { mission: missionId, version: String(missionVersion), board, pid, site: o.site }, signal: o.signal, timeoutMs: opts.readTimeoutMs ?? 10_000 });
}
