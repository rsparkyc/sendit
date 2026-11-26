/**
 * The leaderboard's single adapter to the game code (as src/app/mission-layer.ts
 * is for the app). Nothing else under server/ imports src/mission or src/physics.
 *
 * It owns:
 *  - the mission catalogue as the leaderboard sees it (id + version), built
 *    from the mission layer's exported definitions;
 *  - the rules a plan must obey: the mission layer's own conformance check
 *    (spacecraft, duration, start kind, sites, window, altitude) plus a few
 *    server limits (dates inside the checkpoint asset, tolerance range);
 *  - the world (real ephemeris + checkpoint asset) and the replay +
 *    objective evaluation that produce the authoritative result, with the
 *    mission layer's quantised leaderboard keys;
 *  - a bounded module-scope cache of built ephemeris chunks.
 *
 * WHEN THE MISSION LAYER CHANGES. Only this file needs to follow: `catalogue`
 * (where the definitions come from), `defaultCatalogue`, `versionOf` and `checkRules`.
 */
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { ASSET_FIRST_DAY, ASSET_LAST_DAY, installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../../src/physics/solar-system';
import * as campaign from '../../src/mission/campaign';
import { LAUNCH_SITES } from '../../src/mission/launch';
import { allowedSites, checkPlanConformance, evaluate, missionReplayOptions, type Evaluation, type MissionDefinition } from '../../src/mission/objectives';
import { decodePlan, encodePlan, LIMITS, PlanError, validatePlanIssues, type MissionPlan } from '../../src/mission/plan';
import { replay, type ReplayOptions, type ReplayResult } from '../../src/mission/replay';
import { SAMPLE_MISSIONS } from '../../src/mission/samples';
import { PHYSICS_MODEL, worldFromBodyData, type MissionWorld } from '../../src/mission/world';

/**
 * True if a higher `Evaluation.score` is better (objectives.ts: "Combined
 * score (higher is better)"). If the scoring ever becomes a cost, flip this
 * one constant (and bump every mission version).
 */
export const SCORE_HIGHER_IS_BETTER = true;

const DAY = 86400;
const YEAR = 365.25 * DAY;
const CHUNK_MARGIN = 3600;

export interface MissionInfo {
  readonly id: string;
  /** def.version as a string when the definition has one, else 'h' + a content hash. */
  readonly version: string;
  readonly title: string;
  readonly def: MissionDefinition;
  /** Every launch site of the site table with its standing in this mission (offered first, in table order). */
  readonly sites: readonly SiteInfo[];
}

/** A launch site as the leaderboard reports it for a mission. */
export interface SiteInfo {
  readonly id: string;
  readonly name: string;
  readonly offered: boolean;
  /** Not offered: why. */
  readonly reason?: string;
  /** Offered with a reference solution (campaign missions): its delta-v (m/s) and time (s), and this site's limits. */
  readonly deltaV?: number;
  readonly time?: number;
  readonly maxDeltaV?: number;
  readonly maxTime?: number;
}

/** Board key of the site a plan launches from ('state' for a free state start, which only sandbox-like missions allow). */
export function siteOfPlan(plan: MissionPlan): string {
  return plan.start.kind === 'launch' ? plan.start.site : 'state';
}

function sitesOf(def: MissionDefinition): SiteInfo[] {
  const allowed = allowedSites(def);
  const out = LAUNCH_SITES.map((s): SiteInfo => {
    const o = def.launchSites?.find((x) => x.site === s.id);
    if (o && o.offered) return { id: s.id, name: s.name, offered: true, deltaV: o.deltaV, time: o.time, maxDeltaV: o.maxDeltaV, maxTime: o.maxTime };
    if (o) return { id: s.id, name: s.name, offered: false, reason: o.reason };
    return allowed === undefined || allowed.includes(s.id) ? { id: s.id, name: s.name, offered: true } : { id: s.id, name: s.name, offered: false, reason: 'not offered for this mission' };
  });
  return [...out.filter((s) => s.offered), ...out.filter((s) => !s.offered)];
}

/** Server limits on top of the mission's own rules. */
export interface ServerRules {
  /** Allowed start kinds when the mission says nothing (a free 'state' start could begin anywhere). */
  readonly launchOnlyByDefault: boolean;
  /** The whole flight must lie in [earliest, latest], TDB s from J2000 (checkpoint asset range: cheap, bounded chunk builds). */
  readonly earliest: number;
  readonly latest: number;
  /** Longest flight accepted when the mission sets no maxDuration, s. */
  readonly maxDuration: number;
  /** Integrator tolerance range accepted (loose tolerances could be exploited; tight ones cost steps). */
  readonly minRtol: number;
  readonly maxRtol: number;
}

export interface RuleIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** What the server computes for a plan. */
export interface Verdict {
  /** 'ok': flew and evaluated. Anything else: no score. */
  readonly status: 'ok' | 'timeout' | 'limit' | 'invalid' | 'error';
  readonly success: boolean;
  /** Leaderboard values: the mission layer's keys (score; delta-v to 0.1 m/s and time to 1 s, rounded up). */
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
  readonly digest: string;
  readonly outcome: string;
  readonly reason: string;
  /** Objective summary for the client (kind, ok, detail). */
  readonly objectives: readonly { kind: string; ok: boolean; detail: string }[];
  readonly ms: number;
  readonly steps: number;
}

export interface VerifyOptions {
  /** Absolute Date.now() deadline: chunk building and the replay stop when it passes. */
  readonly deadline: number;
  /** Integrator step budget. */
  readonly maxSteps: number;
  /** Re-verification of stored plans made against an older physics / data version. */
  readonly allowVersionMismatch?: boolean;
}

/** Everything the service needs from the game code; tests replace `fly`. */
export interface Engine {
  readonly model: number;
  readonly fingerprint: string;
  /** `${model}.${fingerprint}`: the physics version entries are verified under. */
  readonly physicsVersion: string;
  missions(): readonly MissionInfo[];
  mission(id: string): MissionInfo | undefined;
  /** Strict decode + structural and launch validation. Throws PlanError. */
  decode(encoded: string): MissionPlan;
  /** Canonical encoding (the decoder accepts only canonical strings, so decode then encode is the identity). */
  encode(plan: MissionPlan): string;
  checkRules(plan: MissionPlan, m: MissionInfo): RuleIssue[];
  /** Number of 128-day ephemeris chunks the plan's span needs that are not built yet. */
  missingChunks(plan: MissionPlan): number;
  verify(plan: MissionPlan, m: MissionInfo, opts: VerifyOptions): Verdict;
}

// ------------------------------------------------------------------ catalogue

/** Stable JSON (sorted keys) for hashing a definition. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** FNV-1a 32-bit, hex. Only a change detector for definitions without a version. */
function fnv32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

export function versionOf(def: MissionDefinition): string {
  const v = (def as { version?: unknown }).version;
  if ((typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && VERSION_RE.test(v))) return String(v);
  return `h${fnv32(stableJson(def))}`;
}

const isMission = (x: unknown): x is MissionDefinition =>
  typeof x === 'object' && x !== null && typeof (x as MissionDefinition).id === 'string' && Array.isArray((x as MissionDefinition).objectives) && typeof (x as MissionDefinition).scoring === 'object';

/**
 * The leaderboard's missions: the campaign's versioned definitions (every
 * exported mission object of src/mission/campaign.ts, or its exported list),
 * else the sample missions with content-hash versions.
 */
function defaultCatalogue(): MissionDefinition[] {
  const found = new Map<string, MissionDefinition>();
  for (const v of Object.values(campaign as Record<string, unknown>)) {
    for (const d of Array.isArray(v) ? v : [v]) if (isMission(d) && d.version !== undefined && !found.has(d.id)) found.set(d.id, d);
  }
  return found.size > 0 ? [...found.values()] : [...SAMPLE_MISSIONS];
}

function buildCatalogue(defs: readonly MissionDefinition[]): MissionInfo[] {
  const seen = new Set<string>();
  const out: MissionInfo[] = [];
  for (const def of defs) {
    if (seen.has(def.id)) throw new Error(`leaderboard: duplicate mission id ${def.id}`);
    seen.add(def.id);
    out.push({ id: def.id, version: versionOf(def), title: def.title, def, sites: sitesOf(def) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export const SERVER_RULES: ServerRules = {
  launchOnlyByDefault: true,
  earliest: ASSET_FIRST_DAY * DAY,
  latest: ASSET_LAST_DAY * DAY,
  maxDuration: LIMITS.maxDuration,
  minRtol: 1e-12,
  maxRtol: 1e-10,
};

/** Every reason the plan may not be submitted for this mission (empty: fine). */
export function checkRules(plan: MissionPlan, def: MissionDefinition, rules: ServerRules = SERVER_RULES): RuleIssue[] {
  const out: RuleIssue[] = checkPlanConformance(def, plan).map((i) => ({ code: i.code, path: i.path, message: i.message }));
  const add = (code: string, path: string, message: string) => out.push({ code, path, message });
  const missionSaysStart = def.rules?.launchOnly !== undefined || def.start !== undefined;
  if (rules.launchOnlyByDefault && !missionSaysStart && plan.start.kind !== 'launch') add('start-kind', 'start.kind', 'leaderboard flights must start with a launch');
  if (!(plan.epoch >= rules.earliest && plan.epoch + plan.duration <= rules.latest)) add('date', 'epoch', `the whole flight must lie between ${isoOf(rules.earliest)} and ${isoOf(rules.latest)}`);
  if (def.maxDuration === undefined) {
    const maxTime = def.objectives.find((o) => o.kind === 'max-time');
    const limit = Math.min(rules.maxDuration, maxTime && maxTime.kind === 'max-time' ? maxTime.max : Infinity);
    if (!(plan.duration <= limit)) add('duration', 'duration', `the flight may last at most ${(limit / DAY).toFixed(2)} days for this mission`);
  }
  if (!(plan.rtol >= rules.minRtol && plan.rtol <= rules.maxRtol)) add('rtol', 'rtol', `integrator tolerance must be in [${rules.minRtol}, ${rules.maxRtol}]`);
  return out;
}

/** J2000 is 2000-01-01T12:00 TT; TDB-UTC differs by about a minute, irrelevant for a message. */
function isoOf(tdb: number): string {
  return new Date(Date.UTC(2000, 0, 1, 12) + tdb * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------- world

export interface EngineOptions {
  /** Checkpoint asset bytes (src/physics/data/checkpoints-1950-2100.bin). Without them chunk builds are far slower. */
  readonly checkpoints?: Uint8Array;
  /** Most built chunks kept in memory (LRU). */
  readonly maxChunks?: number;
  /** Replace the expensive part (tests). Default: real replay + evaluate. */
  readonly fly?: (plan: MissionPlan, m: MissionInfo, opts: VerifyOptions) => Verdict;
  /** Replace the catalogue (tests). */
  readonly catalogue?: readonly MissionDefinition[];
}

export function createEngine(o: EngineOptions = {}): Engine {
  const catalogue = buildCatalogue(o.catalogue ?? defaultCatalogue());
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const eph = new ChebyshevEphemeris(J2000_BODIES);
  if (o.checkpoints) installCheckpointAsset(eph, J2000_BODIES, o.checkpoints);
  const world: MissionWorld = worldFromBodyData(eph, J2000_BODIES);
  const maxChunks = o.maxChunks ?? 160;
  const lastUse = new Map<number, number>();
  let clock = 0;

  const span = (plan: MissionPlan): [number, number] => [eph.chunkIndex(plan.epoch - CHUNK_MARGIN), eph.chunkIndex(plan.epoch + plan.duration + CHUNK_MARGIN)];

  const missingChunks = (plan: MissionPlan): number => {
    const [a, b] = span(plan);
    let n = 0;
    for (let k = a; k <= b; k++) if (!eph.hasChunk(k)) n++;
    return n;
  };

  /** Build the plan's chunks one at a time (deadline checked between builds), then evict LRU. */
  const prepare = (plan: MissionPlan, deadline: number): boolean => {
    const [a, b] = span(plan);
    const tick = ++clock;
    for (let k = a; k <= b; k++) {
      if (!eph.hasChunk(k)) {
        if (Date.now() > deadline) return false;
        const t = eph.t0 + k * eph.layout.chunkSpan;
        eph.ensure(t, t);
      }
      lastUse.set(k, tick);
    }
    const built = eph.builtChunks();
    if (built.length > maxChunks) {
      const victims = built.filter((k) => k < a || k > b).sort((x, y) => (lastUse.get(x) ?? 0) - (lastUse.get(y) ?? 0)).slice(0, built.length - maxChunks);
      eph.evict(victims);
      for (const k of victims) lastUse.delete(k);
    }
    return true;
  };

  const realFly = (plan: MissionPlan, m: MissionInfo, opts: VerifyOptions): Verdict => {
    const t0 = Date.now();
    if (!prepare(plan, opts.deadline)) return verdict('timeout', null, null, 'ran out of time building the ephemeris', Date.now() - t0);
    const ro: ReplayOptions = {
      ...missionReplayOptions(m.def),
      maxSteps: opts.maxSteps,
      allowVersionMismatch: opts.allowVersionMismatch,
      shouldStop: () => Date.now() > opts.deadline,
    };
    const r = replay(plan, world, ro);
    const ms = Date.now() - t0;
    if (r.outcome === 'aborted') return verdict('timeout', r, null, 'replay ran out of time', ms);
    if (r.outcome === 'step-limit' || r.outcome === 'event-limit') return verdict('limit', r, null, r.reason, ms);
    if (r.outcome === 'invalid-plan' || r.outcome === 'version-mismatch' || r.outcome === 'unsupported-start') return verdict('invalid', r, null, r.reason, ms);
    if (r.outcome === 'physics-error') return verdict('error', r, null, r.reason, ms);
    return verdict('ok', r, evaluate(m.def, r, world, plan.epoch, plan), r.reason, ms);
  };

  return {
    model: PHYSICS_MODEL,
    fingerprint: world.fingerprint,
    physicsVersion: `${PHYSICS_MODEL}.${world.fingerprint}`,
    missions: () => catalogue,
    mission: (id) => byId.get(id),
    decode: (s) => {
      const plan = decodePlan(s);
      // decodePlan checks the format only; also the launch semantics (site, azimuth corridor, altitude).
      const issues = validatePlanIssues(plan);
      if (issues.length > 0) throw new PlanError(`invalid plan: ${issues.map((i) => i.message).join('; ')}`);
      return plan;
    },
    encode: encodePlan,
    checkRules: (plan, m) => checkRules(plan, m.def),
    missingChunks,
    verify: o.fly ?? realFly,
  };
}

function verdict(status: Verdict['status'], r: ReplayResult | null, ev: Evaluation | null, reason: string, ms: number): Verdict {
  // Rank on the mission layer's quantised keys (what the player sees); raw values only if it gives none.
  const keys = ev?.keys;
  return {
    status,
    success: status === 'ok' && ev !== null && ev.success,
    score: keys?.score ?? ev?.score ?? 0,
    deltaV: keys ? keys.deltaV / 10 : (ev?.deltaV ?? r?.deltaV ?? 0),
    missionTime: keys ? keys.time : (ev?.missionTime ?? r?.elapsed ?? 0),
    digest: r?.digest ?? '',
    outcome: r?.outcome ?? status,
    reason,
    objectives: ev ? [...ev.objectives.map((x) => ({ kind: x.objective.kind, ok: x.ok, detail: x.detail })), ...(ev.ruleViolations ?? []).map((d) => ({ kind: 'rule', ok: false, detail: d }))] : [],
    ms,
    steps: r?.steps ?? 0,
  };
}

export { PlanError, LIMITS as PLAN_LIMITS, YEAR };
export type { MissionPlan };
