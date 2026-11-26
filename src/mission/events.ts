/**
 * Trajectory events, found during propagation from the integrator's dense
 * output (the `onStep(t, y, interpolate, tPrev)` hook of propagate()).
 *
 * METHOD. For every body b and every accepted step [tPrev, t]:
 *  1. Sample g(s) = r.v (spacecraft relative to b) at NODES+1 equally spaced
 *     times, with the spacecraft from the step's interpolant and the body from
 *     the ephemeris. g is half the derivative of d^2, so a sign change - to +
 *     brackets a local minimum of distance (periapsis / closest approach) and
 *     + to - a local maximum (apoapsis). Each bracket is refined by bisection.
 *  2. Between consecutive extrema (and the step ends) the distance is
 *     monotonic, so each threshold radius (surface, atmosphere top, requested
 *     spheres) is crossed at most once per piece: compare d^2 - R^2 at the
 *     piece ends and bisect if the sign differs.
 * An extremum inside a step is therefore found even if both step ends are far
 * away, and an impact is found whenever the minimum lies below the surface,
 * so a trajectory cannot pass through a body within one long step.
 *
 * WHY THE SAMPLING CANNOT MISS A FLYBY. In the two-body problem
 * d(r.v)/dt = v^2 - mu/r = 2E + mu/r, which is > 0 whenever the relative
 * orbit is unbound (E >= 0). So for any hyperbolic or parabolic pass g is
 * strictly increasing: it has exactly one sign change and it is caught from
 * the step end points alone, however long the step (test/mission-events.test.ts
 * checks a 30 km/s pass inside one step of > 10 000 s). For bound relative
 * motion a minimum and the following maximum are half a period apart, and
 * would both have to fall in one sub-interval of length (t - tPrev)/NODES,
 * i.e. a step of NODES/2 periods, which the error control never takes
 * around the attracting body. Thrust and third bodies perturb this, which is
 * what the interior nodes are for.
 *
 * ROOTS: bisection with a fixed cap of BISECT_MAX iterations, stopping early
 * only when the midpoint is no longer strictly inside the bracket (float
 * resolution of t). Deterministic and engine independent.
 *
 * Bracket conventions are half-open so a root exactly on a step boundary is
 * reported once: a minimum when g(a) < 0 <= g(b), a maximum when g(a) > 0 >= g(b),
 * entry when s(a) > 0 >= s(b), exit when s(a) <= 0 < s(b).
 *
 * DETERMINISM: exactly-defined operations only.
 */
import type { Ephemeris, Interpolator } from '../physics/spacecraft';
import { bodyIndexOf, type MissionWorld } from './world';

export const NODES = 4;
export const BISECT_MAX = 80;

export type EventKind =
  /** Local minimum of distance to the body (closest approach). */
  | 'periapsis'
  /** Local maximum of distance to the body. */
  | 'apoapsis'
  /** Crossed the surface radius inward. Terminal. */
  | 'impact'
  /** Crossed the atmosphere top inward. Terminal unless stopOnAtmosphere is false. */
  | 'atmosphere-entry'
  | 'atmosphere-exit'
  /** Crossed a requested sphere inward / outward. */
  | 'enter'
  | 'exit';

export interface TrajectoryEvent {
  readonly kind: EventKind;
  /** Seconds from the ephemeris epoch (same time as propagate). */
  readonly t: number;
  readonly body: string;
  /** Distance from the body centre, m. */
  readonly distance: number;
  /** distance - body radius, m. */
  readonly altitude: number;
  /** Speed relative to the body, m/s. */
  readonly speed: number;
  /** Spacecraft state relative to the body [x, y, z, vx, vy, vz]. */
  readonly rel: readonly number[];
  /** Spacecraft mass, kg. */
  readonly mass: number;
  /** For enter / exit: the sphere radius. */
  readonly sphere?: number;
}

export interface SphereSpec {
  readonly body: string;
  /** Radius from the body centre, m. */
  readonly radius: number;
}

export interface EventOptions {
  /** Body ids to watch; default all bodies in the world. */
  readonly bodies?: readonly string[];
  readonly spheres?: readonly SphereSpec[];
  /** Default true: atmosphere entry ends the flight (no aerodynamics are modelled). */
  readonly stopOnAtmosphere?: boolean;
}

const KIND_ORDER: Record<EventKind, number> = {
  impact: 0,
  'atmosphere-entry': 1,
  'atmosphere-exit': 2,
  enter: 3,
  exit: 4,
  periapsis: 5,
  apoapsis: 6,
};

interface Threshold {
  radius: number;
  inward: EventKind | null;
  outward: EventKind | null;
  sphere: boolean;
}

/**
 * Stateful event finder. Call `start` with the initial state, then `step` from
 * propagate's onStep. A non-null return is a terminal event: stop propagating.
 */
export class EventFinder {
  readonly events: TrajectoryEvent[] = [];
  private readonly eph: Ephemeris;
  private readonly watch: number[];
  private readonly ids: string[];
  private readonly radii: number[];
  private readonly thresholds: Threshold[][];
  private readonly sc = new Float64Array(7);
  private readonly bs = new Float64Array(6);
  private readonly rel = new Float64Array(6);
  private readonly nodeT = new Float64Array(NODES + 1);
  private readonly nodeY: Float64Array[] = [];
  private interp: Interpolator | null = null;

  constructor(world: MissionWorld, opts: EventOptions = {}) {
    this.eph = world.ephemeris;
    const stopAtm = opts.stopOnAtmosphere ?? true;
    const ids = opts.bodies ?? world.bodies.map((b) => b.id);
    this.watch = [];
    this.ids = [];
    this.radii = [];
    this.thresholds = [];
    for (const id of ids) {
      const i = bodyIndexOf(world, id);
      if (i < 0) throw new Error(`events: unknown body ${id}`);
      const b = world.bodies[i];
      const th: Threshold[] = [{ radius: b.radius, inward: 'impact', outward: null, sphere: false }];
      if (b.atmosphere > 0) {
        th.push({ radius: b.radius + b.atmosphere, inward: 'atmosphere-entry', outward: stopAtm ? null : 'atmosphere-exit', sphere: false });
      }
      this.watch.push(i);
      this.ids.push(id);
      this.radii.push(b.radius);
      this.thresholds.push(th);
    }
    for (const s of opts.spheres ?? []) {
      const k = this.ids.indexOf(s.body);
      if (k < 0) throw new Error(`events: sphere around unwatched or unknown body ${s.body}`);
      if (!(s.radius > 0) || s.radius === Infinity) throw new Error(`events: bad sphere radius ${s.radius}`);
      this.thresholds[k].push({ radius: s.radius, inward: 'enter', outward: 'exit', sphere: true });
    }
    for (let i = 0; i <= NODES; i++) this.nodeY.push(new Float64Array(7));
  }

  /** Check the initial state. Returns a terminal event if it starts inside a body (or its atmosphere). */
  start(t: number, y: ArrayLike<number>): TrajectoryEvent | null {
    for (let k = 0; k < this.watch.length; k++) {
      this.sc.set(y);
      this.relative(k, t);
      const d2 = this.d2();
      for (const th of this.thresholds[k]) {
        if (th.inward !== null && !th.sphere && th.outward === null && d2 <= th.radius * th.radius) {
          const ev = this.make(th.inward, t, k);
          this.events.push(ev);
          return ev;
        }
      }
    }
    return null;
  }

  /** Process one accepted step. Returns the terminal event if the flight ends inside it. */
  step(t: number, interp: Interpolator, tPrev: number): TrajectoryEvent | null {
    this.interp = interp;
    const nodeT = this.nodeT;
    const h = t - tPrev;
    for (let i = 0; i <= NODES; i++) {
      nodeT[i] = i === 0 ? tPrev : i === NODES ? t : tPrev + (h * i) / NODES;
      interp(nodeT[i], this.nodeY[i]);
    }
    const found: TrajectoryEvent[] = [];
    const g = new Float64Array(NODES + 1);
    for (let k = 0; k < this.watch.length; k++) {
      for (let i = 0; i <= NODES; i++) {
        this.sc.set(this.nodeY[i]);
        this.relative(k, nodeT[i]);
        g[i] = this.rv();
      }
      // Piece boundaries: step ends plus every extremum, with d^2 at each.
      const bt: number[] = [tPrev];
      for (let i = 0; i < NODES; i++) {
        const a = g[i];
        const b = g[i + 1];
        const isMin = a < 0 && b >= 0;
        const isMax = a > 0 && b <= 0;
        if (!isMin && !isMax) continue;
        const tr = this.bisect(k, nodeT[i], nodeT[i + 1], isMin ? 'lt0' : 'gt0', null);
        found.push(this.make(isMin ? 'periapsis' : 'apoapsis', tr, k));
        if (tr > bt[bt.length - 1] && tr < t) bt.push(tr);
      }
      bt.push(t);
      const bd2: number[] = bt.map((tb) => this.d2At(k, tb));
      for (const th of this.thresholds[k]) {
        const r2 = th.radius * th.radius;
        for (let p = 0; p + 1 < bt.length; p++) {
          const sa = bd2[p] - r2;
          const sb = bd2[p + 1] - r2;
          if (sa > 0 && sb <= 0 && th.inward !== null) {
            found.push(this.make(th.inward, this.bisect(k, bt[p], bt[p + 1], 'gt0', r2), k, th.sphere ? th.radius : undefined));
          } else if (sa <= 0 && sb > 0 && th.outward !== null) {
            found.push(this.make(th.outward, this.bisect(k, bt[p], bt[p + 1], 'le0', r2), k, th.sphere ? th.radius : undefined));
          }
        }
      }
    }
    this.interp = null;
    found.sort((x, y) => (x.t !== y.t ? (x.t < y.t ? -1 : 1) : KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.body < y.body ? -1 : x.body > y.body ? 1 : 0)));
    for (const ev of found) {
      this.events.push(ev);
      if (ev.kind === 'impact' || (ev.kind === 'atmosphere-entry' && this.isTerminalAtm(ev.body))) return ev;
    }
    return null;
  }

  /** Spacecraft state at t (only valid inside step()). */
  stateAt(t: number, out: Float64Array): void {
    if (this.interp === null) throw new Error('stateAt outside step');
    this.interp(t, out);
  }

  private isTerminalAtm(id: string): boolean {
    const th = this.thresholds[this.ids.indexOf(id)];
    for (const x of th) if (x.inward === 'atmosphere-entry') return x.outward === null;
    return false;
  }

  /**
   * Bisection for the first point where `holds` stops being true, given it is
   * true at a and false at b. holds is f < 0 ('lt0') or f > 0 ('gt0') or
   * f <= 0 ('le0'), with f = r.v (r2 null) or d^2 - r2.
   */
  private bisect(k: number, a: number, b: number, holds: 'lt0' | 'gt0' | 'le0', r2: number | null): number {
    let lo = a;
    let hi = b;
    for (let it = 0; it < BISECT_MAX; it++) {
      const mid = lo + (hi - lo) * 0.5;
      if (!(mid > lo && mid < hi)) break;
      this.scAt(mid);
      this.relative(k, mid);
      const f = r2 === null ? this.rv() : this.d2() - r2;
      const ok = holds === 'lt0' ? f < 0 : holds === 'gt0' ? f > 0 : f <= 0;
      if (ok) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  private scAt(t: number): void {
    if (this.interp === null) throw new Error('no step');
    this.interp(t, this.sc);
  }

  private d2At(k: number, t: number): number {
    this.scAt(t);
    this.relative(k, t);
    return this.d2();
  }

  private relative(k: number, t: number): void {
    const { sc, bs, rel } = this;
    this.eph.bodyState(this.watch[k], t, bs);
    for (let j = 0; j < 6; j++) rel[j] = sc[j] - bs[j];
  }

  private rv(): number {
    const r = this.rel;
    return r[0] * r[3] + r[1] * r[4] + r[2] * r[5];
  }

  private d2(): number {
    const r = this.rel;
    return r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  }

  /** Build an event at t (recomputes the state there). */
  private make(kind: EventKind, t: number, k: number, sphere?: number): TrajectoryEvent {
    if (this.interp !== null) this.scAt(t);
    this.relative(k, t);
    const r = this.rel;
    const distance = Math.sqrt(this.d2());
    const speed = Math.sqrt(r[3] * r[3] + r[4] * r[4] + r[5] * r[5]);
    const ev: TrajectoryEvent = {
      kind,
      t,
      body: this.ids[k],
      distance,
      altitude: distance - this.radii[k],
      speed,
      rel: Array.from(r),
      mass: this.sc[6],
    };
    return sphere === undefined ? ev : { ...ev, sphere };
  }
}
