/**
 * Solar-system bodies and an `Ephemeris` backed by the N-body integrator.
 *
 * The body list is data-driven (src/physics/data/solar-system-j2000.json,
 * produced by scripts/fetch-horizons.py).
 *
 * BODIES (J2000_BODIES): Sun, Mercury, Venus, Earth, Moon, the Mars system
 * barycenter, the planets Jupiter, Saturn, Uranus, Neptune and Pluto THEMSELVES
 * (not their system barycenters), then 16 major moons, each with `parent`
 * (the Moon's parent is Earth). Indices 0..10 keep the ids of the older
 * 11-body set. A planet's GM is the system GM minus its modelled moons and
 * minus any moon OUTSIDE the innermost modelled moon's orbit (an exterior mass
 * lumped into the planet adds a central pull the real system does not have:
 * Pluto's small moons made Charon drift 39.5 km/yr); the generator then shifts
 * the modelled bodies so their centre of mass is the system barycenter
 * (Saturn 173 m, Pluto 92 m). Unmodelled moons inside the orbits stay lumped in.
 *
 * MOON SELECTION. Required: Io, Europa, Ganymede, Callisto, Titan, Triton,
 * Charon. For the rest two numbers were used (GM from the JPL satellite
 * ephemeris headers, a = semi-major axis): the planet's displacement from its
 * system barycenter that the moon causes, GM_moon/GM_system * a (how wrong the
 * planet's position is if the moon is not modelled), and the moon's escape
 * speed sqrt(2 GM/R) (the largest deflection a flyby of it can give):
 *   Saturn: Iapetus 11.3 km / 0.57 km/s, Rhea 2.1 / 0.64, Dione 0.73 / 0.51,
 *     Tethys 0.32 / 0.39: included. Enceladus 0.045 / 0.24, Mimas 0.012 /
 *     0.16: left out (they cost Tethys ~750 km and Dione ~100 km per year
 *     through resonances; an experiment with both modelled gave 104 and 5 km).
 *     Hyperion, Phoebe, Helene: left out and, being exterior, not lumped in.
 *   Uranus: Oberon 20.6 / 0.73, Titania 17.1 / 0.76, Umbriel 3.9 / 0.54,
 *     Ariel 2.7 / 0.54: included. Miranda 0.10 km / 0.19 km/s, period 1.41 d:
 *     included from physics model 2, as an exception to the rule below:
 *     without it Ariel was 184 km and Umbriel 90 km off Horizons after one
 *     year (with it: 1.2 and 0.7 km). Its period is shorter than Io's, but at
 *     the 1/32 d step its own error is 2.4 m per year.
 *   Mars: Phobos 1.6e-4 km / 0.011 km/s, Deimos 5e-5 km / 0.006 km/s, and a
 *     7.7 h period that alone would need ~4x the sub-steps of Io: left out;
 *     Mars stays a system barycenter.
 *   Pluto: Nix, Hydra, Kerberos, Styx (GM < 0.003): left out, and (exterior
 *     to Charon) not lumped into Pluto.
 * Rule: include a moon if it moves its planet by > 0.25 km or can deflect a
 * spacecraft by > 0.35 km/s, or if leaving it out costs a modelled moon more
 * than its neighbours' error; and its period is not much shorter than Io's.
 *
 * POLES: every zonal field turns with its body's IAU pole (see orientation.ts
 * and the TIME-DEPENDENT FORCES note in nbody.ts); `pole` in the data is that
 * model at J2000. solarSystemPhysics(..., { fixedPoles: true }) gives the
 * model-1 behaviour (pole frozen at J2000) for comparisons.
 *
 * BARYCENTER_BODIES is the older 11-body set (Jupiter..Pluto as system
 * barycenters with the system GM), kept for the baseline tests and as a cheap
 * planetary-only option.
 *
 * DETERMINISM: exactly-defined operations only (+ - * /, Math.sqrt, abs,
 * min/max, floor, comparisons); the pole model's sin/cos come from dmath.
 */
import data from './data/solar-system-j2000.json';
import type { Ephemeris } from './spacecraft';
import { KAHAN_LI_8, NBodyIntegrator, type NBodyPhysics, type ZonalHarmonic } from './nbody';
import { IAU_ROTATION, type IauRotation } from './orientation';

export interface BodyData {
  readonly id: string;
  /** Technical name, e.g. "Mars system barycenter". */
  readonly name: string;
  /** Name for labels, e.g. "Mars". */
  readonly displayName?: string;
  /** GM, m^3/s^2. */
  readonly gm: number;
  /** Mean radius, m. */
  readonly radius: number;
  /** Barycentric ICRF [x,y,z,vx,vy,vz] at J2000 TDB, m and m/s. */
  readonly state: readonly number[];
  /**
   * Spin-axis unit vector in ICRF at J2000: the IAU WGCCRE 2015 north pole
   * (pck00011, periodic terms included). The dynamics orient the zonal field
   * by the time-dependent pole of the same model (rotationOf, orientation.ts).
   */
  readonly pole?: readonly number[];
  /** Unnormalized zonal harmonic J2, referred to j2Radius. */
  readonly j2?: number;
  /** J2 reference radius, m. */
  readonly j2Radius?: number;
  /** Unnormalized zonal harmonic J4, referred to j2Radius. */
  readonly j4?: number;
  /** For a moon: id of its planet. */
  readonly parent?: string;
}

/** Planets, the Moon and the major moons of the giant planets and Pluto (see header). */
export const J2000_BODIES: readonly BodyData[] = data.bodies;

/** The older 11-body set: as J2000_BODIES without moons and with system barycenters for Jupiter..Pluto. */
export const BARYCENTER_BODIES: readonly BodyData[] = data.bodies
  .slice(0, 11)
  .map((b): BodyData => data.systemBarycenters.find((s) => s.id === b.id) ?? b);
export const DAY = 86400;
export const JULIAN_YEAR = 365.25 * DAY;

/**
 * Step for the planetary set (BARYCENTER_BODIES): 0.5 day. From the
 * step-halving study in test/nbody-solar-system.test.ts: halving it moves the
 * Moon by ~2 m and every planet by < 4 cm after 50 years, ~5 orders of
 * magnitude below the error from missing physics (GR, Earth J2). The scheme is
 * still in its h^8 regime at 2 d, so this leaves a 4x margin.
 */
export const PLANETARY_STEP = 0.5 * DAY;

/**
 * Default step, for the full set with moons: 1/32 day (45 min). Io (1.77 d)
 * and Tethys (1.89 d) set it. Measured in test/nbody-moons.test.ts against
 * 1/64 d over one year: Io 370 m at 1/16 d, 14 m at 1/24 d, 3 m at 1/32 d
 * (ratio 1/16 -> 1/24 is 26 = 1.5^8: the h^8 regime, so 1/32 d leaves a 2x
 * margin in step), every other moon <= 2 m, planets < 1 mm. That is far
 * below the moons' missing-physics error against Horizons (tens of km and
 * more, see that test). A multirate scheme was measured and not adopted
 * (see nbody.ts, "STEP AND MOONS").
 */
export const DEFAULT_STEP = DAY / 32;

export function bodyIndex(id: string, bodies: readonly BodyData[] = J2000_BODIES): number {
  const i = bodies.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`unknown body ${id}`);
  return i;
}

/** Oblateness of one body in the form the spacecraft and N-body code consume, or null. */
export interface Oblateness {
  readonly j2: number;
  /** Present for Jupiter..Neptune. */
  readonly j4?: number;
  readonly radius: number;
  /** J2000 pole (BodyData.pole). */
  readonly pole: readonly [number, number, number];
  /** IAU rotation model: when present, the field is oriented by its pole at the current time. */
  readonly rotation?: IauRotation;
}

/** The IAU rotation model of a body (src/physics/data/iau-rotation.json), if there is one. */
export function rotationOf(b: BodyData): IauRotation | undefined {
  return Object.prototype.hasOwnProperty.call(IAU_ROTATION, b.id) ? IAU_ROTATION[b.id] : undefined;
}

/**
 * Oblateness of a body, or null. `fixedPole`: leave out the rotation model, so
 * the field keeps the J2000 pole (the physics before model 2; for comparisons).
 */
export function oblatenessOf(b: BodyData, fixedPole = false): Oblateness | null {
  if (b.j2 === undefined || b.j2Radius === undefined || b.pole === undefined) return null;
  const pole: [number, number, number] = [b.pole[0], b.pole[1], b.pole[2]];
  const rotation = fixedPole ? undefined : rotationOf(b);
  const base = b.j4 === undefined ? { j2: b.j2, radius: b.j2Radius, pole } : { j2: b.j2, j4: b.j4, radius: b.j2Radius, pole };
  return rotation === undefined ? base : { ...base, rotation };
}

/** Build zonal terms from (body id -> target ids) pairs. */
export function zonalTerms(pairs: Readonly<Record<string, readonly string[]>>, bodies: readonly BodyData[] = J2000_BODIES, fixedPole = false): ZonalHarmonic[] {
  const out: ZonalHarmonic[] = [];
  for (const id of Object.keys(pairs)) {
    const i = bodyIndex(id, bodies);
    const ob = oblatenessOf(bodies[i], fixedPole);
    if (ob === null) throw new Error(`${id} has no J2 data`);
    const targets = pairs[id].map((t) => bodyIndex(t, bodies));
    const z: ZonalHarmonic = ob.j4 === undefined ? { body: i, j2: ob.j2, radius: ob.radius, pole: ob.pole, targets } : { body: i, j2: ob.j2, j4: ob.j4, radius: ob.radius, pole: ob.pole, targets };
    if (ob.rotation !== undefined) z.rotation = ob.rotation;
    out.push(z);
  }
  return out;
}

/**
 * Which J2 pairs act among the massive bodies (body -> bodies it acts on; the
 * reaction is always applied). Chosen from the measured displacement each pair
 * alone causes after 100 years (h = 1 d, with Sun 1PN), against a numerical
 * noise floor of a few metres:
 *   Earth -> Moon 1940 km, Moon -> Earth 36 km, Jupiter -> Sun 16 km (moves
 *   Jupiter), Sun -> Mercury 12 km, Sun -> Venus 3 km, Saturn -> Sun 1.9 km,
 *   Sun -> Earth 1.3 km, Sun -> Mars 530 m, Earth -> Sun 365 m, Sun -> Moon 97 m,
 *   Mars -> Sun 73 m, Sun -> Jupiter 23 m; Uranus/Neptune -> Sun and every
 *   planet -> planet pair < 10 m (indistinguishable from noise): excluded.
 * Sun -> all and planet -> Sun are kept uniformly since they cost O(n).
 * With moons, each giant planet's zonal field (J2 and, where the data has it,
 * J4) also acts on its own moons: that is what precesses their orbits (Io's
 * node and perihelion by ~50 deg/yr). Pairs whose bodies are absent from a
 * body list are dropped, so the same table serves BARYCENTER_BODIES unchanged.
 */
export const MASSIVE_BODY_J2_PAIRS: Readonly<Record<string, readonly string[]>> = {
  sun: ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'],
  earth: ['moon', 'sun'],
  moon: ['earth'],
  mars: ['sun'],
  jupiter: ['sun', 'io', 'europa', 'ganymede', 'callisto'],
  saturn: ['sun', 'tethys', 'dione', 'rhea', 'titan', 'iapetus'],
  uranus: ['sun', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon'],
  neptune: ['sun', 'triton'],
};

/** An integrator for these bodies with the full physics, starting at J2000 (t = 0). */
export function createSolarSystemIntegrator(h: number = DEFAULT_STEP, bodies: readonly BodyData[] = J2000_BODIES): NBodyIntegrator {
  return new NBodyIntegrator(bodies.map((b) => b.gm), initialState(bodies), 0, h, KAHAN_LI_8, solarSystemPhysics(bodies));
}

/**
 * Full massive-body physics for these bodies: selected J2 (and J4) pairs,
 * each oriented by the body's time-dependent IAU pole, + Sun 1PN.
 * `opts.fixedPoles`: keep every field on its J2000 pole instead (comparisons only).
 */
export function solarSystemPhysics(
  bodies: readonly BodyData[] = J2000_BODIES,
  pairs: Readonly<Record<string, readonly string[]>> = MASSIVE_BODY_J2_PAIRS,
  opts: { fixedPoles?: boolean } = {},
): NBodyPhysics {
  const ids = new Set(bodies.map((b) => b.id));
  const present: Record<string, readonly string[]> = {};
  for (const id of Object.keys(pairs)) if (ids.has(id)) present[id] = pairs[id].filter((t) => ids.has(t));
  return { zonal: zonalTerms(present, bodies, opts.fixedPoles === true), relativity: { sun: bodyIndex('sun', bodies) } };
}

export function initialState(bodies: readonly BodyData[] = J2000_BODIES): Float64Array {
  const s = new Float64Array(6 * bodies.length);
  bodies.forEach((b, i) => s.set(b.state, 6 * i));
  return s;
}

/**
 * Ephemeris that integrates on demand, forward and backward from the epoch, and
 * stores position, velocity and acceleration of every body at every step.
 * Between samples it uses quintic Hermite interpolation (exact to O(h^6)).
 *
 * Measured accuracy at the default 0.5 d step (test/nbody-ephemeris.test.ts):
 * interpolated Moon position within ~0.1 m of a direct integration to the same
 * time. Memory is 72*n bytes per step (n bodies); a century is ~58 MB for 11
 * bodies, so this is for smoke tests, not production (that is a Chebyshev fit).
 *
 * Physics defaults to solarSystemPhysics(bodies) (J2 pairs + Sun 1PN). Pass
 * `{}` for Newtonian point masses. It also exposes every body's J2 and the
 * Sun's relativity to the spacecraft through the Ephemeris interface.
 */
export class IntegratedEphemeris implements Ephemeris {
  readonly count: number;
  readonly gm: Float64Array;
  readonly physics: NBodyPhysics;
  readonly oblateness: readonly (Oblateness | null)[];
  readonly relativity?: { readonly body: number };
  readonly h: number;
  readonly t0: number;
  private readonly fwd: NBodyIntegrator;
  private readonly bwd: NBodyIntegrator;
  /** fwdSamples[k] is the sample at t0 + k*h; bwdSamples[k] at t0 - k*h. Layout: q(3n) v(3n) a(3n). */
  private readonly fwdSamples: Float64Array[] = [];
  private readonly bwdSamples: Float64Array[] = [];

  constructor(bodies: readonly BodyData[] = J2000_BODIES, h: number = DEFAULT_STEP, t0 = 0, physics?: NBodyPhysics) {
    this.count = bodies.length;
    this.gm = Float64Array.from(bodies.map((b) => b.gm));
    this.h = h;
    this.t0 = t0;
    this.physics = physics ?? solarSystemPhysics(bodies);
    this.oblateness = bodies.map((b) => oblatenessOf(b));
    if (this.physics.relativity) this.relativity = { body: this.physics.relativity.sun };
    const s = initialState(bodies);
    this.fwd = new NBodyIntegrator(this.gm, s, t0, h, KAHAN_LI_8, this.physics);
    this.bwd = new NBodyIntegrator(this.gm, s, t0, -h, KAHAN_LI_8, this.physics);
    const first = this.snapshot(this.fwd);
    this.fwdSamples.push(first);
    this.bwdSamples.push(first);
  }

  private snapshot(it: NBodyIntegrator): Float64Array {
    const m = 3 * this.count;
    const out = new Float64Array(3 * m);
    out.set(it.q, 0);
    out.set(it.v, m);
    it.totalAcceleration(out.subarray(2 * m));
    return out;
  }

  /** Sample k steps from the epoch (k may be negative), integrating as needed. */
  private sample(k: number): Float64Array {
    if (k >= 0) {
      while (this.fwdSamples.length <= k) {
        this.fwd.step();
        this.fwdSamples.push(this.snapshot(this.fwd));
      }
      return this.fwdSamples[k];
    }
    const j = -k;
    while (this.bwdSamples.length <= j) {
      this.bwd.step();
      this.bwdSamples.push(this.snapshot(this.bwd));
    }
    return this.bwdSamples[j];
  }

  /** Evaluate positions (and optionally velocities) of all bodies at t. */
  evaluate(t: number, pos: Float64Array | null, vel: Float64Array | null): void {
    const x = (t - this.t0) / this.h;
    const k = Math.floor(x);
    const s = x - k;
    const p0 = this.sample(k);
    const p1 = this.sample(k + 1);
    const dt = this.h;
    const m = 3 * this.count;
    const s2 = s * s;
    const s3 = s2 * s;
    const s4 = s3 * s;
    const s5 = s4 * s;
    if (pos !== null) {
      const h0 = 1 - 10 * s3 + 15 * s4 - 6 * s5;
      const h1 = (s - 6 * s3 + 8 * s4 - 3 * s5) * dt;
      const h2 = (0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) * dt * dt;
      const h3 = (0.5 * s3 - s4 + 0.5 * s5) * dt * dt;
      const h4 = (-4 * s3 + 7 * s4 - 3 * s5) * dt;
      const h5 = 10 * s3 - 15 * s4 + 6 * s5;
      for (let i = 0; i < m; i++) {
        pos[i] = h0 * p0[i] + h5 * p1[i] + h1 * p0[m + i] + h4 * p1[m + i] + h2 * p0[2 * m + i] + h3 * p1[2 * m + i];
      }
    }
    if (vel !== null) {
      const d0 = (-30 * s2 + 60 * s3 - 30 * s4) / dt;
      const d1 = 1 - 18 * s2 + 32 * s3 - 15 * s4;
      const d2 = (s - 4.5 * s2 + 6 * s3 - 2.5 * s4) * dt;
      const d3 = (1.5 * s2 - 4 * s3 + 2.5 * s4) * dt;
      const d4 = -12 * s2 + 28 * s3 - 15 * s4;
      const d5 = (30 * s2 - 60 * s3 + 30 * s4) / dt;
      for (let i = 0; i < m; i++) {
        vel[i] = d0 * p0[i] + d5 * p1[i] + d1 * p0[m + i] + d4 * p1[m + i] + d2 * p0[2 * m + i] + d3 * p1[2 * m + i];
      }
    }
  }

  positions(t: number, out: Float64Array): void {
    this.evaluate(t, out, null);
  }

  private readonly tmpP = new Float64Array(3 * 64);
  private readonly tmpV = new Float64Array(3 * 64);
  bodyState(body: number, t: number, out: Float64Array): void {
    const p = this.tmpP.length >= 3 * this.count ? this.tmpP : new Float64Array(3 * this.count);
    const v = this.tmpV.length >= 3 * this.count ? this.tmpV : new Float64Array(3 * this.count);
    this.evaluate(t, p, v);
    for (let k = 0; k < 3; k++) {
      out[k] = p[3 * body + k];
      out[3 + k] = v[3 * body + k];
    }
  }
}
