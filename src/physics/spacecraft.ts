/**
 * Spacecraft dynamics: a test particle under the gravity of every massive body,
 * plus finite-thrust burns. Units are SI (m, s, kg); time is seconds from epoch.
 *
 * State vector: [x, y, z, vx, vy, vz, mass] in the ephemeris' inertial frame.
 *
 * Same determinism rule as dop853.ts: only exactly-defined operations (+ - * /,
 * Math.sqrt, Math.abs, Math.min/max, comparisons); no transcendental functions.
 */
import { Dop853, type ScaleFn } from './dop853';

export const G0 = 9.80665; // standard gravity, m/s^2 (defines Isp)
export const STATE_SIZE = 7;

export interface Ephemeris {
  readonly count: number;
  /** Gravitational parameters GM, m^3/s^2. */
  readonly gm: ArrayLike<number>;
  /** Write x,y,z of every body at time t into out[3*i ..]. */
  positions(t: number, out: Float64Array): void;
  /** Write position and velocity of one body into out[0..5]. */
  bodyState(body: number, t: number, out: Float64Array): void;
}

export type BurnFrame =
  /** Direction is a fixed vector in the inertial frame. */
  | { kind: 'inertial' }
  /**
   * Direction is (prograde, normal, radial-out) relative to `body`, and the
   * thrust vector tracks that frame for the whole burn.
   */
  | { kind: 'orbital'; body: number };

export interface Burn {
  /** Ignition time, s. */
  tStart: number;
  /** Requested burn time, s. Cut short if propellant runs out. */
  duration: number;
  /** Thrust, N. */
  thrust: number;
  /** Specific impulse, s. */
  isp: number;
  /** Thrust direction in `frame`. Need not be normalised. */
  direction: readonly [number, number, number];
  frame: BurnFrame;
}

export interface PropagateOptions {
  /** Relative tolerance per step. Default 1e-12. */
  rtol?: number;
  /** Mass at which the tanks are empty, kg. Default 0. */
  dryMass?: number;
  /**
   * Called after every accepted step. `y` is reused; copy it to keep it.
   * `interpolate(t, out)` gives the state at any t in [tPrev, t] of the step just
   * taken, using the right-hand side that step was integrated with. It is valid
   * only during this callback and throws if kept and called later.
   */
  onStep?: (t: number, y: Float64Array, interpolate: Interpolator, tPrev: number) => void;
}

export type Interpolator = (t: number, out: Float64Array) => void;

export interface PropagateResult {
  t: number;
  y: Float64Array;
  accepted: number;
  rejected: number;
}

/** Error scale by vector magnitude, so a coordinate passing through zero doesn't stall the step. */
function spacecraftScale(rtol: number): ScaleFn {
  const ATOL_R = 1e-3; // m
  const ATOL_V = 1e-9; // m/s
  const ATOL_M = 1e-9; // kg
  return (y, yNew, scale) => {
    const r0 = Math.sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2]);
    const r1 = Math.sqrt(yNew[0] * yNew[0] + yNew[1] * yNew[1] + yNew[2] * yNew[2]);
    const v0 = Math.sqrt(y[3] * y[3] + y[4] * y[4] + y[5] * y[5]);
    const v1 = Math.sqrt(yNew[3] * yNew[3] + yNew[4] * yNew[4] + yNew[5] * yNew[5]);
    const sr = ATOL_R + rtol * (r0 > r1 ? r0 : r1);
    const sv = ATOL_V + rtol * (v0 > v1 ? v0 : v1);
    scale[0] = scale[1] = scale[2] = sr;
    scale[3] = scale[4] = scale[5] = sv;
    scale[6] = ATOL_M + rtol * (y[6] > yNew[6] ? y[6] : yNew[6]);
  };
}

function validateBurns(burns: readonly Burn[]): void {
  for (let i = 0; i < burns.length; i++) {
    const b = burns[i];
    if (!(b.duration > 0) || !(b.thrust > 0) || !(b.isp > 0)) {
      throw new Error(`burn ${i}: duration, thrust and isp must be positive`);
    }
    const [dx, dy, dz] = b.direction;
    if (dx * dx + dy * dy + dz * dz === 0) throw new Error(`burn ${i}: zero direction`);
    if (i > 0 && b.tStart < burns[i - 1].tStart + burns[i - 1].duration) {
      throw new Error(`burn ${i}: burns must be sorted and must not overlap`);
    }
  }
}

/**
 * Propagate a spacecraft from t0 to t1 through a list of burns.
 *
 * The integrator stops exactly on every ignition and cutoff, so the right-hand
 * side is smooth inside each integration segment.
 */
export function propagate(
  ephem: Ephemeris,
  y0: ArrayLike<number>,
  t0: number,
  t1: number,
  burns: readonly Burn[] = [],
  opts: PropagateOptions = {},
): PropagateResult {
  validateBurns(burns);
  const rtol = opts.rtol ?? 1e-12;
  const dryMass = opts.dryMass ?? 0;
  const nBodies = ephem.count;
  const gm = ephem.gm;
  const bodyPos = new Float64Array(3 * nBodies);
  const ref = new Float64Array(6);

  // Burn currently firing, with its direction pre-normalised.
  let active: Burn | null = null;
  let activeIndex = -1;
  let ux = 0;
  let uy = 0;
  let uz = 0;

  const deriv = (t: number, y: Float64Array, out: Float64Array): void => {
    const x = y[0];
    const yy = y[1];
    const z = y[2];
    let ax = 0;
    let ay = 0;
    let az = 0;

    ephem.positions(t, bodyPos);
    for (let i = 0; i < nBodies; i++) {
      const dx = bodyPos[3 * i] - x;
      const dy = bodyPos[3 * i + 1] - yy;
      const dz = bodyPos[3 * i + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const k = gm[i] / (d2 * Math.sqrt(d2));
      ax += k * dx;
      ay += k * dy;
      az += k * dz;
    }

    let mdot = 0;
    if (active !== null) {
      let tx = ux;
      let ty = uy;
      let tz = uz;
      if (active.frame.kind === 'orbital') {
        ephem.bodyState(active.frame.body, t, ref);
        const rx = x - ref[0];
        const ry = yy - ref[1];
        const rz = z - ref[2];
        const vx = y[3] - ref[3];
        const vy = y[4] - ref[4];
        const vz = y[5] - ref[5];
        // prograde
        const v2 = vx * vx + vy * vy + vz * vz;
        if (!(v2 > 0)) {
          throw new Error(`burn ${activeIndex}: orbital frame undefined (zero velocity relative to body ${active.frame.body})`);
        }
        const vInv = 1 / Math.sqrt(v2);
        const px = vx * vInv;
        const py = vy * vInv;
        const pz = vz * vInv;
        // normal = r x v
        let nx = ry * vz - rz * vy;
        let ny = rz * vx - rx * vz;
        let nz = rx * vy - ry * vx;
        const n2 = nx * nx + ny * ny + nz * nz;
        if (!(n2 > 0)) {
          throw new Error(`burn ${activeIndex}: orbital frame undefined (velocity parallel to radius from body ${active.frame.body})`);
        }
        const nInv = 1 / Math.sqrt(n2);
        nx *= nInv;
        ny *= nInv;
        nz *= nInv;
        // radial-out = prograde x normal
        const ox = py * nz - pz * ny;
        const oy = pz * nx - px * nz;
        const oz = px * ny - py * nx;
        tx = ux * px + uy * nx + uz * ox;
        ty = ux * py + uy * ny + uz * oy;
        tz = ux * pz + uy * nz + uz * oz;
      }
      const aThrust = active.thrust / y[6];
      ax += aThrust * tx;
      ay += aThrust * ty;
      az += aThrust * tz;
      mdot = -active.thrust / (active.isp * G0);
    }

    out[0] = y[3];
    out[1] = y[4];
    out[2] = y[5];
    out[3] = ax;
    out[4] = ay;
    out[5] = az;
    out[6] = mdot;
  };

  const integ = new Dop853(STATE_SIZE, deriv, spacecraftScale(rtol));
  integ.reset(t0, y0);
  let coastStep = integ.h;

  // Dense output is exposed only inside onStep, i.e. before `active` can change.
  let inCallback = false;
  const interpolate: Interpolator = (t, out) => {
    if (!inCallback) throw new Error('interpolate is only valid during onStep');
    integ.interpolate(t, out);
  };
  const userOnStep = opts.onStep;
  const onStep = userOnStep
    ? (t: number, y: Float64Array, it: Dop853) => {
        inCallback = true;
        try {
          userOnStep(t, y, interpolate, it.tPrevious);
        } finally {
          inCallback = false;
        }
      }
    : undefined;

  let i = 0;
  while (integ.t < t1) {
    const t = integ.t;
    while (i < burns.length && burns[i].tStart + burns[i].duration <= t) i++;
    const next = i < burns.length ? burns[i] : null;

    let segEnd = t1;
    let burning: Burn | null = null;
    let runsDry = false;
    if (next !== null && next.tStart <= t) {
      // Inside a burn. Propellant flow is constant, so depletion time is exact.
      const propellant = integ.y[6] - dryMass;
      if (propellant <= 0) {
        i++;
        continue;
      }
      const mdot = next.thrust / (next.isp * G0);
      const requestedEnd = next.tStart + next.duration;
      const dryTime = t + propellant / mdot;
      burning = next;
      if (dryTime < requestedEnd) {
        if (dryTime <= segEnd) {
          segEnd = dryTime;
          runsDry = true;
        }
      } else if (requestedEnd < segEnd) {
        segEnd = requestedEnd;
      }
    } else if (next !== null && next.tStart < segEnd) {
      segEnd = next.tStart;
    }

    if (burning !== active) {
      active = burning;
      activeIndex = burning !== null ? i : -1;
      if (active !== null) {
        const [dx, dy, dz] = active.direction;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        ux = dx * inv;
        uy = dy * inv;
        uz = dz * inv;
        coastStep = integ.h;
        integ.refresh();
        // Burns are short next to a coast step; let the controller find the new scale.
        const span = segEnd - t;
        if (integ.h > span / 8) integ.h = span / 8;
      } else {
        integ.refresh();
        integ.h = coastStep;
      }
    }

    integ.integrateTo(segEnd, onStep);
    // Tanks empty: snap to exactly dryMass so no roundoff residue can restart the engine.
    if (runsDry) integ.y[6] = dryMass;
    if (burning !== null && integ.t >= burning.tStart + burning.duration) i++;
    else if (runsDry) i++;
  }

  return {
    t: integ.t,
    y: Float64Array.from(integ.y),
    accepted: integ.accepted,
    rejected: integ.rejected,
  };
}

/** Bodies that never move. For tests and two-body sanity checks. */
export class FixedBodies implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  private readonly pos: Float64Array;

  constructor(bodies: readonly { gm: number; position: readonly [number, number, number] }[]) {
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.pos = new Float64Array(3 * bodies.length);
    bodies.forEach((b, i) => this.pos.set(b.position, 3 * i));
  }

  positions(_t: number, out: Float64Array): void {
    out.set(this.pos);
  }

  bodyState(body: number, _t: number, out: Float64Array): void {
    out[0] = this.pos[3 * body];
    out[1] = this.pos[3 * body + 1];
    out[2] = this.pos[3 * body + 2];
    out[3] = out[4] = out[5] = 0;
  }
}
