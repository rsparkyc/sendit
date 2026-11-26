/**
 * Mission plan: everything needed to replay a flight, with a compact binary
 * encoding to a URL-safe string.
 *
 * Plans arrive from untrusted sources (shared links, a leaderboard), so
 * `decodePlan` checks every byte, rejects anything malformed with a clear
 * error, and `validatePlan` bounds the work a plan can demand (burns,
 * duration, tolerance). Floats are stored as raw IEEE-754 binary64, so every
 * value round-trips exactly.
 *
 * BINARY LAYOUT (little-endian), format 1:
 *   'S' u8 format  u16 model  u32 data-fingerprint
 *   f64 epoch  f64 duration  f64 rtol
 *   start: u8 tag; 0 = state: str center, 6 x f64 (relative to center at epoch)
 *                  1 = launch: str site, u8 n, n x f64 params
 *   f64 wetMass  f64 dryMass  u8 nEngines, nEngines x (f64 thrust, f64 isp)
 *   u16 nBurns, per burn: f64 start  f64 duration  u8 engine  3 x f64 direction
 *                         u8 frame (0 inertial, 1 orbital + str body)
 *   str = u8 length + ASCII [a-z0-9_-]
 * then base64url without padding.
 *
 * TIME RULES (one clock for everything):
 *  - `epoch` is mission time zero, TDB seconds from J2000. For a launch start
 *    it is the LIFTOFF time and must equal params[0] (the launch time).
 *  - Burn `start` and the mission `duration` are seconds after the epoch, so
 *    burns sit at absolute times epoch + start; mission elapsed time (and so
 *    scoring) counts from the epoch, i.e. from liftoff for a launch.
 *  - A 'state' start begins simulating at the epoch. A launch start begins at
 *    orbit insertion, epoch + ascent time (params[3], default
 *    DEFAULT_ASCENT_TIME_S): a burn starting before insertion, or a duration
 *    not reaching past insertion, is a validation error.
 */
import { DEFAULT_ASCENT_TIME_S, LAUNCH_SITES, azimuthAllowed } from './launch';
import { PHYSICS_MODEL } from './world';

export const PLAN_FORMAT = 1;

export const LIMITS = {
  /** Longest encoded string accepted, characters. */
  maxEncodedLength: 16384,
  maxBurns: 200,
  maxEngines: 8,
  maxLaunchParams: 16,
  /** Mission duration, s (40 Julian years). */
  maxDuration: 40 * 365.25 * 86400,
  /** |epoch| from J2000, s (200 Julian years). */
  maxEpoch: 200 * 365.25 * 86400,
  minRtol: 1e-13,
  maxRtol: 1e-5,
  maxMass: 1e9,
  maxThrust: 1e9,
  maxIsp: 1e5,
  maxPosition: 1e14,
  maxVelocity: 1e6,
  maxIdLength: 32,
} as const;

export interface Engine {
  /** N. */
  readonly thrust: number;
  /** s. */
  readonly isp: number;
}

export interface Spacecraft {
  /** Initial (fuelled) mass, kg. */
  readonly wetMass: number;
  /** Mass with empty tanks, kg. */
  readonly dryMass: number;
  readonly engines: readonly Engine[];
}

export type PlanFrame = { readonly kind: 'inertial' } | { readonly kind: 'orbital'; readonly body: string };

export interface PlanBurn {
  /** Ignition, seconds after the epoch. */
  readonly start: number;
  /** Requested duration, s; cut short if the tanks run dry. */
  readonly duration: number;
  /** Index into spacecraft.engines. */
  readonly engine: number;
  readonly direction: readonly [number, number, number];
  readonly frame: PlanFrame;
}

export type PlanStart =
  /** State [x, y, z, vx, vy, vz] (m, m/s) relative to body `center` at the epoch. */
  | { readonly kind: 'state'; readonly center: string; readonly state: readonly number[] }
  /**
   * Seam for launch descriptions (built elsewhere): an id and numeric
   * parameters. Replay needs a `resolveLaunch` option to turn it into a state.
   */
  | { readonly kind: 'launch'; readonly site: string; readonly params: readonly number[] };

export interface MissionPlan {
  readonly format: number;
  /** PHYSICS_MODEL the plan was made with. */
  readonly model: number;
  /** World fingerprint (8 hex digits) the plan was made against. */
  readonly data: string;
  /** Start time, TDB seconds from J2000 (the ephemeris time). */
  readonly epoch: number;
  /** Mission length, s. */
  readonly duration: number;
  /** Integrator relative tolerance. */
  readonly rtol: number;
  readonly start: PlanStart;
  readonly spacecraft: Spacecraft;
  /** Sorted, non-overlapping. */
  readonly burns: readonly PlanBurn[];
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Convenience constructor that fills format and model. */
export function makePlan(p: Omit<MissionPlan, 'format' | 'model'>): MissionPlan {
  return { format: PLAN_FORMAT, model: PHYSICS_MODEL, ...p };
}

const ID_RE = /^[a-z0-9_-]+$/;

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Seconds from the epoch at which simulation starts (orbit insertion for a launch). */
export function simulationStartOffset(start: PlanStart): number {
  return start.kind === 'launch' ? (start.params[3] ?? DEFAULT_ASCENT_TIME_S) : 0;
}

/** Stable machine-readable codes for plan problems (never renamed; new ones may be added). */
export type PlanIssueCode =
  | 'format'
  | 'model'
  | 'data'
  | 'range'
  | 'id'
  | 'start-kind'
  | 'start-state'
  | 'launch-params'
  | 'launch-epoch'
  | 'launch-ascent'
  | 'launch-duration'
  | 'launch-site'
  | 'launch-azimuth'
  | 'launch-altitude'
  | 'launch-mode'
  | 'burn-before-insertion'
  | 'mass-order'
  | 'engines'
  | 'burns'
  | 'burn-engine'
  | 'burn-direction'
  | 'burn-frame'
  | 'burn-overlap';

/** One problem with a plan. */
export interface PlanIssue {
  readonly code: PlanIssueCode;
  /** Field path, e.g. 'epoch', 'start.params[1]', 'burns[2].direction', 'spacecraft.dryMass'. */
  readonly path: string;
  /** Index of the burn the problem belongs to, when it belongs to one. */
  readonly burn?: number;
  /** Human-readable message (the same text validatePlan returns). */
  readonly message: string;
}

export interface ValidateOptions {
  /**
   * How much of a launch start to check:
   *  - 'full' (default): also that the site exists, the parameters decode
   *    (launch.ts launchFromParams), the azimuth is inside the site's
   *    range-safety corridor and the altitude is positive, so a plan that
   *    launch.ts would refuse fails here, not inside replay.
   *  - 'structural': only the plan format (what encode / decode need). Used
   *    for plans flown with a custom `resolveLaunch` (their own site ids).
   */
  readonly launch?: 'full' | 'structural';
}

/**
 * All problems with a plan, structured (empty if valid). Checks structure,
 * ranges and the work bounds, and (by default) the launch semantics.
 */
export function validatePlanIssues(plan: MissionPlan, opts: ValidateOptions = {}): PlanIssue[] {
  const errs: PlanIssue[] = [];
  const L = LIMITS;
  const add = (code: PlanIssueCode, path: string, message: string, burn?: number) => {
    errs.push(burn === undefined ? { code, path, message } : { code, path, burn, message });
  };
  const burnOf = (path: string): number | undefined => {
    const m = /^burns\[(\d+)\]/.exec(path);
    return m ? Number(m[1]) : undefined;
  };
  const range = (name: string, v: unknown, lo: number, hi: number, loOpen = false) => {
    if (!finite(v) || (loOpen ? !(v > lo) : !(v >= lo)) || !(v <= hi)) add('range', name, `${name} must be a finite number in ${loOpen ? '(' : '['}${lo}, ${hi}], got ${String(v)}`, burnOf(name));
  };
  const id = (name: string, v: unknown) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > L.maxIdLength || !ID_RE.test(v)) add('id', name, `${name} must be an id of 1-${L.maxIdLength} characters [a-z0-9_-], got ${JSON.stringify(v)}`, burnOf(name));
  };
  if (plan.format !== PLAN_FORMAT) add('format', 'format', `unsupported plan format ${plan.format} (this build reads ${PLAN_FORMAT})`);
  if (!Number.isInteger(plan.model) || plan.model < 0 || plan.model > 0xffff) add('model', 'model', `model must be an integer 0-65535`);
  if (typeof plan.data !== 'string' || !/^[0-9a-f]{8}$/.test(plan.data)) add('data', 'data', `data fingerprint must be 8 hex digits`);
  range('epoch', plan.epoch, -L.maxEpoch, L.maxEpoch);
  range('duration', plan.duration, 0, L.maxDuration, true);
  range('rtol', plan.rtol, L.minRtol, L.maxRtol);

  const st = plan.start;
  if (st?.kind === 'state') {
    id('start.center', st.center);
    if (!Array.isArray(st.state) || st.state.length !== 6) add('start-state', 'start.state', 'start.state must have 6 numbers');
    else {
      for (let i = 0; i < 3; i++) range(`start.state[${i}]`, st.state[i], -L.maxPosition, L.maxPosition);
      for (let i = 3; i < 6; i++) range(`start.state[${i}]`, st.state[i], -L.maxVelocity, L.maxVelocity);
    }
  } else if (st?.kind === 'launch') {
    id('start.site', st.site);
    if (!Array.isArray(st.params) || st.params.length > L.maxLaunchParams) add('launch-params', 'start.params', `start.params must be at most ${L.maxLaunchParams} numbers`);
    else {
      let allFinite = true;
      st.params.forEach((v, i) => { if (!finite(v)) { allFinite = false; add('launch-params', `start.params[${i}]`, `start.params[${i}] must be finite`); } });
      if (st.params.length < 1 || st.params[0] !== plan.epoch) add('launch-epoch', 'start.params[0]', 'start.params[0] (launch time) must equal epoch: the epoch of a launch plan is liftoff');
      const ascent = simulationStartOffset(st);
      if (!(ascent >= 0 && ascent <= 86400)) add('launch-ascent', 'start.params[3]', `launch ascent time must be in [0, 86400] s, got ${ascent}`);
      else {
        if (!(plan.duration > ascent)) add('launch-duration', 'duration', `duration must extend past orbit insertion (${ascent} s after liftoff)`);
        if (Array.isArray(plan.burns)) plan.burns.forEach((b, i) => { if (finite(b?.start) && b.start < ascent) add('burn-before-insertion', `burns[${i}].start`, `burns[${i}] starts at ${b.start} s, before orbit insertion at ${ascent} s after liftoff`, i); });
      }
      if ((opts.launch ?? 'full') === 'full' && allFinite && typeof st.site === 'string') launchIssues(st.site, st.params, add);
    }
  } else add('start-kind', 'start.kind', 'start.kind must be "state" or "launch"');

  const sc = plan.spacecraft;
  range('spacecraft.wetMass', sc?.wetMass, 0, L.maxMass, true);
  range('spacecraft.dryMass', sc?.dryMass, 0, L.maxMass, true);
  if (finite(sc?.wetMass) && finite(sc?.dryMass) && sc.dryMass > sc.wetMass) add('mass-order', 'spacecraft.dryMass', 'spacecraft.dryMass must not exceed wetMass');
  const engines = sc?.engines;
  if (!Array.isArray(engines) || engines.length < 1 || engines.length > L.maxEngines) add('engines', 'spacecraft.engines', `spacecraft needs 1-${L.maxEngines} engines`);
  else engines.forEach((e, i) => {
    range(`engines[${i}].thrust`, e?.thrust, 0, L.maxThrust, true);
    range(`engines[${i}].isp`, e?.isp, 0, L.maxIsp, true);
  });

  const burns = plan.burns;
  if (!Array.isArray(burns) || burns.length > L.maxBurns) add('burns', 'burns', `at most ${L.maxBurns} burns`);
  else {
    let prevEnd = -Infinity;
    burns.forEach((b, i) => {
      const n = `burns[${i}]`;
      range(`${n}.start`, b?.start, 0, L.maxDuration);
      range(`${n}.duration`, b?.duration, 0, L.maxDuration, true);
      if (!Number.isInteger(b?.engine) || b.engine < 0 || !Array.isArray(engines) || b.engine >= engines.length) add('burn-engine', `${n}.engine`, `${n}.engine must index spacecraft.engines`, i);
      const d = b?.direction;
      if (!Array.isArray(d) || d.length !== 3 || !d.every((x) => finite(x) && Math.abs(x) <= 1e6)) add('burn-direction', `${n}.direction`, `${n}.direction must be 3 finite numbers with |x| <= 1e6`, i);
      else if (!(d[0] * d[0] + d[1] * d[1] + d[2] * d[2] > 1e-24)) add('burn-direction', `${n}.direction`, `${n}.direction must not be zero`, i);
      if (b?.frame?.kind === 'orbital') id(`${n}.frame.body`, b.frame.body);
      else if (b?.frame?.kind !== 'inertial') add('burn-frame', `${n}.frame.kind`, `${n}.frame.kind must be "inertial" or "orbital"`, i);
      if (finite(b?.start) && finite(b?.duration)) {
        if (b.start < prevEnd) add('burn-overlap', `${n}.start`, `${n} starts before the previous burn ends (burns must be sorted and not overlap)`, i);
        prevEnd = b.start + b.duration;
      }
    });
  }
  return errs;
}

/** Launch semantics, mirroring what launch.ts launchFromParams / launchState would refuse. */
function launchIssues(siteId: string, params: readonly number[], add: (code: PlanIssueCode, path: string, message: string) => void): void {
  const site = LAUNCH_SITES.find((s) => s.id === siteId);
  if (!site) {
    add('launch-site', 'start.site', `start.site: unknown launch site ${siteId} (known: ${LAUNCH_SITES.map((s) => s.id).join(', ')})`);
    return;
  }
  if (params.length < 3 || params.length > 6) {
    add('launch-params', 'start.params', `start.params: a parking-orbit launch takes 3 to 6 parameters [time, azimuth, altitude, ascent?, downrange?, circularization?], got ${params.length}`);
    return;
  }
  const c = params[5] ?? 0;
  if (c !== 0 && c !== 1) add('launch-mode', 'start.params[5]', `start.params[5] (circularization) must be 0 (j2-mean) or 1 (two-body), got ${c}`);
  if (!azimuthAllowed(site, params[1])) add('launch-azimuth', 'start.params[1]', `start.params[1]: azimuth ${params[1]} deg is outside ${site.id}'s range-safety corridor ${site.azimuthMinDeg}..${site.azimuthMaxDeg} deg`);
  if (!(params[2] > 0 && params[2] <= MAX_PARKING_ALTITUDE)) add('launch-altitude', 'start.params[2]', `start.params[2]: parking-orbit altitude must be in (0, ${MAX_PARKING_ALTITUDE}] m, got ${params[2]}`);
}

/** Highest parking-orbit altitude a launch start accepts, m. */
export const MAX_PARKING_ALTITUDE = 2_000e3;

/**
 * All problems with a plan as messages (empty if valid). Same checks as
 * validatePlanIssues, which also gives the field, burn and a stable code.
 */
export function validatePlan(plan: MissionPlan, opts: ValidateOptions = {}): string[] {
  return validatePlanIssues(plan, opts).map((e) => e.message);
}

export function assertValidPlan(plan: MissionPlan, opts: ValidateOptions = {}): void {
  const errs = validatePlan(plan, opts);
  if (errs.length > 0) throw new PlanError(`invalid plan: ${errs.join('; ')}`);
}

// ---------------------------------------------------------------- encoding

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;
  private need(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    nb.set(this.buf);
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number): void { this.need(1); this.view.setUint8(this.length, v); this.length += 1; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.length, v, true); this.length += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  f64(v: number): void { this.need(8); this.view.setFloat64(this.length, v, true); this.length += 8; }
  str(s: string): void { this.u8(s.length); for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes(): Uint8Array { return this.buf.slice(0, this.length); }
}

class Reader {
  private pos = 0;
  private readonly view: DataView;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) throw new PlanError(`plan is truncated (reading ${what} at byte ${this.pos})`);
  }
  u8(what: string): number { this.need(1, what); return this.view.getUint8(this.pos++); }
  u16(what: string): number { this.need(2, what); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32(what: string): number { this.need(4, what); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f64(what: string): number { this.need(8, what); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  str(what: string): string {
    const n = this.u8(what);
    if (n === 0 || n > LIMITS.maxIdLength) throw new PlanError(`${what}: bad id length ${n}`);
    this.need(n, what);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.pos++]);
    if (!ID_RE.test(s)) throw new PlanError(`${what}: id has invalid characters`);
    return s;
  }
  done(): void {
    if (this.pos !== this.buf.length) throw new PlanError(`plan has ${this.buf.length - this.pos} unexpected trailing bytes`);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let c = 0; c < chars; c++) s += B64[(n >>> (18 - 6 * c)) & 63];
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new PlanError('plan string has an impossible length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const chars = Math.min(4, s.length - i);
    for (let c = 0; c < 4; c++) {
      let v = 0;
      if (c < chars) {
        const code = s.charCodeAt(i + c);
        v = code < 128 ? B64_INV[code] : -1;
        if (v < 0) throw new PlanError(`plan string has an invalid character at position ${i + c}`);
      }
      n = (n << 6) | v;
    }
    out[o++] = (n >>> 16) & 255;
    if (chars > 2) out[o++] = (n >>> 8) & 255;
    if (chars > 3) out[o++] = n & 255;
  }
  // Reject non-canonical encodings (stray bits in the last character).
  if (toBase64Url(out) !== s) throw new PlanError('plan string is not canonical base64url');
  return out;
}

/** Encode a (valid) plan to a URL-safe string. */
export function encodePlan(plan: MissionPlan): string {
  // Format-level checks only: an unknown launch site still encodes (replay refuses it).
  assertValidPlan(plan, { launch: 'structural' });
  const w = new Writer();
  w.u8(0x53);
  w.u8(plan.format);
  w.u16(plan.model);
  w.u32(parseInt(plan.data, 16));
  w.f64(plan.epoch);
  w.f64(plan.duration);
  w.f64(plan.rtol);
  const st = plan.start;
  if (st.kind === 'state') {
    w.u8(0);
    w.str(st.center);
    for (let i = 0; i < 6; i++) w.f64(st.state[i]);
  } else {
    w.u8(1);
    w.str(st.site);
    w.u8(st.params.length);
    for (const p of st.params) w.f64(p);
  }
  const sc = plan.spacecraft;
  w.f64(sc.wetMass);
  w.f64(sc.dryMass);
  w.u8(sc.engines.length);
  for (const e of sc.engines) { w.f64(e.thrust); w.f64(e.isp); }
  w.u16(plan.burns.length);
  for (const b of plan.burns) {
    w.f64(b.start);
    w.f64(b.duration);
    w.u8(b.engine);
    for (let i = 0; i < 3; i++) w.f64(b.direction[i]);
    if (b.frame.kind === 'inertial') w.u8(0);
    else { w.u8(1); w.str(b.frame.body); }
  }
  return toBase64Url(w.bytes());
}

/** Decode and validate. Throws PlanError with a clear message on any problem. */
export function decodePlan(s: string): MissionPlan {
  if (typeof s !== 'string') throw new PlanError('plan must be a string');
  if (s.length > LIMITS.maxEncodedLength) throw new PlanError(`plan string is too long (${s.length} > ${LIMITS.maxEncodedLength})`);
  const r = new Reader(fromBase64Url(s));
  if (r.u8('magic') !== 0x53) throw new PlanError('not a mission plan (bad magic byte)');
  const format = r.u8('format');
  if (format !== PLAN_FORMAT) throw new PlanError(`unsupported plan format ${format} (this build reads ${PLAN_FORMAT})`);
  const model = r.u16('model');
  const data = r.u32('data').toString(16).padStart(8, '0');
  const epoch = r.f64('epoch');
  const duration = r.f64('duration');
  const rtol = r.f64('rtol');
  const tag = r.u8('start kind');
  let start: PlanStart;
  if (tag === 0) {
    const center = r.str('start.center');
    const state: number[] = [];
    for (let i = 0; i < 6; i++) state.push(r.f64('start.state'));
    start = { kind: 'state', center, state };
  } else if (tag === 1) {
    const site = r.str('start.site');
    const n = r.u8('start.params count');
    if (n > LIMITS.maxLaunchParams) throw new PlanError(`too many launch parameters (${n})`);
    const params: number[] = [];
    for (let i = 0; i < n; i++) params.push(r.f64('start.params'));
    start = { kind: 'launch', site, params };
  } else throw new PlanError(`unknown start kind ${tag}`);
  const wetMass = r.f64('wetMass');
  const dryMass = r.f64('dryMass');
  const ne = r.u8('engine count');
  if (ne > LIMITS.maxEngines) throw new PlanError(`too many engines (${ne})`);
  const engines: Engine[] = [];
  for (let i = 0; i < ne; i++) engines.push({ thrust: r.f64('engine thrust'), isp: r.f64('engine isp') });
  const nb = r.u16('burn count');
  if (nb > LIMITS.maxBurns) throw new PlanError(`too many burns (${nb} > ${LIMITS.maxBurns})`);
  const burns: PlanBurn[] = [];
  for (let i = 0; i < nb; i++) {
    const bs = r.f64(`burns[${i}].start`);
    const bd = r.f64(`burns[${i}].duration`);
    const engine = r.u8(`burns[${i}].engine`);
    const direction: [number, number, number] = [r.f64('direction'), r.f64('direction'), r.f64('direction')];
    const fk = r.u8(`burns[${i}].frame`);
    let frame: PlanFrame;
    if (fk === 0) frame = { kind: 'inertial' };
    else if (fk === 1) frame = { kind: 'orbital', body: r.str(`burns[${i}].frame.body`) };
    else throw new PlanError(`burns[${i}]: unknown frame kind ${fk}`);
    burns.push({ start: bs, duration: bd, engine, direction, frame });
  }
  r.done();
  const plan: MissionPlan = { format, model, data, epoch, duration, rtol, start, spacecraft: { wetMass, dryMass, engines }, burns };
  assertValidPlan(plan, { launch: 'structural' });
  return plan;
}
