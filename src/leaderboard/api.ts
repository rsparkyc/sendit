/**
 * Leaderboard HTTP API: request and response shapes, shared by the browser
 * client (client.ts) and the server (server/leaderboard). Types, and the ALL_SITES constant.
 *
 * Routes (same origin, under /api/leaderboard):
 *   GET  /api/leaderboard/missions                         -> MissionsResponse
 *   GET  /api/leaderboard/board?mission=&version=&board=&site=&limit=&cursor=  -> BoardResponse
 *   POST /api/leaderboard/submit   SubmitRequest            -> SubmitResponse
 *   POST /api/leaderboard/me       MeRequest                -> MeResponse
 *   GET  /api/leaderboard/plan?mission=&version=&board=&site=&pid= -> PlanResponse (403 unless the deployment exposes plans)
 * Every error is an ErrorResponse with the HTTP status listed at ErrorCode.
 *
 * LAUNCH SITES. Every board (combined, delta-v, time) exists per launch site
 * and for all sites together. `site` is a launch-site id (one the mission
 * offers: MissionsResponse.missions[].sites) or ALL_SITES ('all', the default,
 * so calls without `site` get the all-sites boards). A player has one row per
 * site on each site board; on an all-sites board, one row (their best over
 * every site) labelled with the site it was flown from. Every row says its site.
 */

/** The `site` value for the all-sites boards. */
export const ALL_SITES = 'all';
/** A launch-site id, or ALL_SITES. */
export type SiteFilter = string;

export type BoardId = 'combined' | 'deltaV' | 'time';

export interface SubmitRequest {
  readonly missionId: string;
  readonly missionVersion: string;
  /** Encoded plan (src/mission/plan.ts encodePlan). */
  readonly plan: string;
  /** Display name, free text (cleaned by the server; see the response for what is shown). */
  readonly name: string;
  /** The player's secret (client.ts makes and keeps it). */
  readonly secret: string;
}

export interface MeRequest {
  readonly missionId: string;
  readonly missionVersion: string;
  readonly secret: string;
  /** Launch-site id or ALL_SITES (default). */
  readonly site?: SiteFilter;
}

export interface Values {
  /** Combined score as computed by the mission layer (higher is better with the current formula). */
  readonly score: number;
  /** m/s */
  readonly deltaV: number;
  /** Seconds from liftoff to the last goal. */
  readonly missionTime: number;
}

export interface PlayerInfo {
  readonly name: string;
  /** 5 characters derived from the player's secret, shown next to the name. */
  readonly tag: string;
  /** Opaque public entry id. */
  readonly pid: string;
}

export interface RankInfo extends Values {
  /** 1-based; null when beyond the server's counting cap (then `beyond` is that cap). */
  readonly rank: number | null;
  readonly beyond?: number;
  /** ISO time of the submission that set this result. */
  readonly submittedAt: string;
  /** Launch site this result was flown from. */
  readonly site: string;
}

export interface BoardEntry extends Values {
  readonly rank: number;
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
  readonly submittedAt: string;
  /** Launch site this result was flown from (on an all-sites board, where the player's best came from). */
  readonly site: string;
}

/** A launch site's standing in a mission. */
export interface MissionSite {
  /** Launch-site id (src/mission/data/launch-sites.json). */
  readonly id: string;
  readonly name: string;
  /** False: plans from this site are refused (rule-violation, code launch-site); `reason` says why. */
  readonly offered: boolean;
  readonly reason?: string;
  /** Offered campaign sites: the reference solution from this site (delta-v m/s, time s) and this site's limits. */
  readonly deltaV?: number;
  readonly time?: number;
  readonly maxDeltaV?: number;
  readonly maxTime?: number;
}

export interface MissionsResponse {
  /** The physics a plan must be made with (plan.model / plan.data). */
  readonly physics: { readonly model: number; readonly data: string };
  /** `sites`: every launch site, offered ones first. */
  readonly missions: readonly { readonly id: string; readonly version: string; readonly title: string; readonly sites: readonly MissionSite[] }[];
  readonly exposePlans: boolean;
}

export interface BoardResponse {
  readonly mission: string;
  readonly version: string;
  readonly board: BoardId;
  /** Launch-site id or ALL_SITES, as requested. */
  readonly site: SiteFilter;
  readonly entries: readonly BoardEntry[];
  /** Pass as `cursor` for the next page; null at the end. */
  readonly next: string | null;
}

export interface SubmitResponse {
  readonly mission: string;
  readonly version: string;
  /** Launch site the flight was flown from. */
  readonly site: string;
  /** What the server computed (never what the client claimed). */
  readonly result: Values & { readonly digest: string };
  /** All-sites boards on which this flight became the player's best. */
  readonly improved: Readonly<Record<BoardId, boolean>>;
  readonly player: PlayerInfo;
  /** The player's all-sites ranks (each RankInfo says which site that best came from). */
  readonly ranks: Readonly<Record<BoardId, RankInfo | null>>;
  /** The same for this flight's site boards. */
  readonly siteImproved: Readonly<Record<BoardId, boolean>>;
  readonly siteRanks: Readonly<Record<BoardId, RankInfo | null>>;
}

export interface MeResponse {
  readonly mission: string;
  readonly version: string;
  /** Launch-site id or ALL_SITES, as requested. */
  readonly site: SiteFilter;
  /** Null if this secret has no entry for the mission version. */
  readonly player: PlayerInfo | null;
  /** Ranks on that site's boards (null where the player has no result there). */
  readonly ranks: Readonly<Record<BoardId, RankInfo | null>>;
}

export interface PlanResponse {
  readonly pid: string;
  readonly board: BoardId;
  readonly site: SiteFilter;
  readonly plan: string;
}

/**
 * Error codes (HTTP status):
 *  bad-request 400, unexpected-field 400 (e.g. a client-supplied score), bad-secret 400, bad-name 400,
 *  name-rejected 422, body-too-large 413, not-found 404, method-not-allowed 405,
 *  unknown-mission 404, mission-version 409 (detail.current), version-mismatch 409 (detail.expected / detail.got),
 *  invalid-plan 422, rule-violation 422 (detail.issues), objectives-not-met 422 (detail.objectives),
 *  replay-limit 422 (the flight needs more integrator steps or events than allowed),
 *  rate-limited 429 (retryAfter), replay-timeout 503 (retryAfter), plans-not-public 403, server-error 500.
 */
export type ErrorCode =
  | 'bad-request'
  | 'unexpected-field'
  | 'bad-secret'
  | 'bad-name'
  | 'name-rejected'
  | 'body-too-large'
  | 'not-found'
  | 'method-not-allowed'
  | 'unknown-mission'
  | 'mission-version'
  | 'version-mismatch'
  | 'invalid-plan'
  | 'rule-violation'
  | 'objectives-not-met'
  | 'replay-limit'
  | 'rate-limited'
  | 'replay-timeout'
  | 'plans-not-public'
  | 'server-error';

export interface ErrorResponse {
  readonly error: ErrorCode;
  readonly message: string;
  readonly detail?: unknown;
  /** Seconds, for rate-limited and replay-timeout. */
  readonly retryAfter?: number;
}
