/**
 * Solar-system bodies and an `Ephemeris` backed by the N-body integrator.
 *
 * The body list is data-driven (src/physics/data/solar-system-j2000.json,
 * produced by scripts/fetch-horizons.py).
 *
 * BODIES (J2000_BODIES): Sun, Mercury, Venus, Earth, Moon, the Mars system
 * barycenter, the planets Jupiter, Saturn, Uranus, Neptune and Pluto THEMSELVES
 * (not their system barycenters), then 18 major moons, each with `parent`
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
 *     0.16: included from stage 2 of model 2 under the third rule below:
 *     without them Tethys was 859 km and Dione 107 km off Horizons after a
 *     year (Tethys-Mimas 4:2, Dione-Enceladus 2:1 resonances); with them (and
 *     Saturn's J3..J8) 94 and 3 km. Mimas' 0.94 d period is shorter than
 *     Io's: at the 1/32 d step its own error is 214 m per year (1/32 vs 1/64
 *     d), against 157 km of physics error. Their ids follow Iapetus, so
 *     Ariel..Charon moved two places up (bodies are looked up by id).
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
 * GRAVITY FIELDS (data: jn, tesseral, fieldTaper; sources in
 * scripts/fetch-horizons.py; evaluation in gravity-field.ts):
 *   Sun: J2 (DE440).
 *   Earth: J2..J4 (DE440) and C/S through degree 4 (EGM2008 tide-free,
 *     rescaled to DE440's GM and radius), body-fixed frame from the IAU pole
 *     and the Earth Rotation Angle with Delta-T (earth-rotation.ts, the same
 *     definition the launch code uses).
 *   Moon: J2..J4 and C/S through degree 4 (DE440, principal-axis frame),
 *     turned with the IAU lunar pole and prime meridian (libration terms).
 *   Mars, Jupiter, Saturn: J2..J9 as the satellite ephemerides list them
 *     (mar099, jup365, sat441); Uranus, Neptune: J2, J4, J6 (ura184,
 *     nep098). Uranus rotates retrograde: even zonals only.
 * Where the line is: degree 4 for Earth and the Moon. Degree 4 leaves 100-140
 * km after 30 days in LEO and low lunar orbit against degree 8 / 6 (the
 * truncation error accepted); each further degree costs evaluation time on
 * every LEO step. Higher planetary tesserals are not in the sources used
 * (Mars has them in mar099, unused: Mars missions are not resolved to that
 * level). Odd zonals and tesserals need the rotational north pole: the IAU
 * north pole for prograde bodies (checked, spacecraft.ts).
 * SPACECRAFT: J2 of every body everywhere; the terms above J2 tapered to zero
 * between fieldTaper radii (Earth 114-143, Moon 136-170, Mars 55-69,
 * Jupiter 66-83, Saturn 62-78, Uranus 35-44, Neptune 36-45 body radii; inner
 * where the largest discarded acceleration falls to 1e-12 m/s^2, ~3 m in 30
 * days). The taper is a C2 quintic step, a smooth function of position.
 * MASSIVE BODIES: J2 (J4) as in MASSIVE_BODY_J2_PAIRS, plus MASSIVE_BODY_FIELDS
 * (Saturn J3..J8 and Jupiter J3..J6 on their moons). Left out, with the
 * measurements in MASSIVE_BODY_FIELDS: Earth J3/J4 and tesserals on the Moon,
 * Moon J3/J4 on Earth (all < 50 m per century), and the Moon's C22 and higher
 * tesserals (100-200 km per century, but the IAU libration model is not
 * accurate enough to apply them: they made the Moon worse against DE441).
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
import type { TesseralTerm } from './gravity-field';
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
  /** Mean radius, m: drawing size only. */
  readonly radius: number;
  /**
   * Reference radius, m: the equatorial radius the gravity field is referred
   * to (j2Radius) where there is a field, else the mean radius. Altitude above
   * a body is distance from its centre minus this radius, everywhere (launch,
   * events, impact and atmosphere thresholds, objectives, planner, UI).
   */
  readonly referenceRadius: number;
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
  /**
   * Unnormalized zonal series J_n for n = 2, 3, ... (jn[0] = J2, equal to j2;
   * jn[2] = J4, equal to j4), referred to j2Radius. See "GRAVITY FIELDS".
   */
  readonly jn?: readonly number[];
  /** Sectoral and tesseral terms [n, m, C_nm, S_nm] (unnormalized, j2Radius, IAU body-fixed frame). */
  readonly tesseral?: readonly (readonly number[])[];
  /** Provenance of jn and tesseral. */
  readonly fieldSource?: string;
  /** Spacecraft taper of the terms above J2: [inner, outer] radius in units of j2Radius (BodyOblateness.taper). */
  readonly fieldTaper?: readonly number[];
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

/** Gravity field of one body in the form the spacecraft and N-body code consume, or null. */
export interface Oblateness {
  readonly j2: number;
  /** Present for Jupiter..Neptune. */
  readonly j4?: number;
  /** Zonal series J_n from n = 2 (BodyData.jn), when the data has one. */
  readonly jn?: readonly number[];
  /** Sectoral and tesseral terms (n, m, C, S) (BodyData.tesseral). */
  readonly tesseral?: readonly TesseralTerm[];
  /** Prime meridian of the body-fixed frame: Earth's is the Earth Rotation Angle (earth-rotation.ts). */
  readonly primeMeridian?: 'iau' | 'earth-rotation-angle';
  /** Taper of the terms above J2 for the spacecraft (BodyOblateness.taper). */
  readonly taper?: readonly [number, number];
  readonly radius: number;
  /** J2000 pole (BodyData.pole). */
  readonly pole: readonly [number, number, number];
  /** IAU rotation model: when present, the field is oriented by its pole (and prime meridian) at the current time. */
  readonly rotation?: IauRotation;
}

/** The IAU rotation model of a body (src/physics/data/iau-rotation.json), if there is one. */
export function rotationOf(b: BodyData): IauRotation | undefined {
  return Object.prototype.hasOwnProperty.call(IAU_ROTATION, b.id) ? IAU_ROTATION[b.id] : undefined;
}

/** Bodies whose body-fixed frame uses the Earth Rotation Angle rather than the IAU W. */
const ERA_BODIES: ReadonlySet<string> = new Set(['earth']);

/**
 * Gravity field of a body, or null: J2 (J4), the zonal series `jn` and the
 * sectoral/tesseral terms where the data has them. `fixedPole`: the physics
 * before model 2 (for comparisons): J2 and J4 only, about the J2000 pole.
 */
export function oblatenessOf(b: BodyData, fixedPole = false): Oblateness | null {
  if (b.j2 === undefined || b.j2Radius === undefined || b.pole === undefined) return null;
  const pole: [number, number, number] = [b.pole[0], b.pole[1], b.pole[2]];
  const base = b.j4 === undefined ? { j2: b.j2, radius: b.j2Radius, pole } : { j2: b.j2, j4: b.j4, radius: b.j2Radius, pole };
  if (fixedPole) return base;
  const rotation = rotationOf(b);
  const more: { jn?: readonly number[]; tesseral?: readonly TesseralTerm[]; primeMeridian?: 'earth-rotation-angle'; taper?: readonly [number, number] } = {};
  if (b.jn !== undefined) more.jn = b.jn;
  if (b.fieldTaper !== undefined) more.taper = [b.fieldTaper[0], b.fieldTaper[1]];
  if (b.tesseral !== undefined && b.tesseral.length > 0) {
    if (rotation === undefined) throw new Error(`${b.id}: tesseral terms need an IAU rotation model`);
    more.tesseral = b.tesseral.map((r) => [r[0], r[1], r[2], r[3]] as const);
    if (ERA_BODIES.has(b.id)) more.primeMeridian = 'earth-rotation-angle';
  }
  return rotation === undefined ? { ...base, ...more } : { ...base, ...more, rotation };
}

/** Which part of a body's field acts between massive bodies (see MASSIVE_BODY_FIELDS). */
export interface MassiveFieldSelection {
  /** Highest degree used (zonal and, with `tesseral`, sectoral/tesseral). */
  readonly degree: number;
  /** Include the sectoral and tesseral terms up to `degree`. */
  readonly tesseral?: boolean;
}

/** The field of `ob` truncated to a selection: J_n and (optionally) C_nm, S_nm with n <= degree. */
export function truncateField(ob: Oblateness, sel: MassiveFieldSelection): { j2: number; j4?: number; jn?: number[]; tesseral?: TesseralTerm[] } {
  const all = ob.jn ?? (ob.j4 !== undefined ? [ob.j2, 0, ob.j4] : [ob.j2]);
  const jn = all.slice(0, Math.max(1, sel.degree - 1));
  const out: { j2: number; j4?: number; jn?: number[]; tesseral?: TesseralTerm[] } = { j2: ob.j2 };
  if (jn.length >= 3 && jn[2] !== 0) out.j4 = jn[2];
  // Only J2/J4: leave jn out, so the field takes the closed J2/J4 form.
  if (jn.some((j, i) => i !== 0 && i !== 2 && j !== 0)) out.jn = jn;
  if (sel.tesseral && ob.tesseral !== undefined) {
    const t = ob.tesseral.filter((r) => r[0] <= sel.degree);
    if (t.length > 0) {
      out.tesseral = t;
      out.jn = jn;
    }
  }
  return out;
}

/**
 * Build field terms from (body id -> target ids) pairs. `fields` selects the
 * degree (and whether sectoral/tesseral terms act) per body; a body not in it
 * acts with J2 and, where the data has it, J4 (the model-1 selection).
 */
export function zonalTerms(
  pairs: Readonly<Record<string, readonly string[]>>,
  bodies: readonly BodyData[] = J2000_BODIES,
  fixedPole = false,
  fields: Readonly<Record<string, MassiveFieldSelection>> = {},
): ZonalHarmonic[] {
  const out: ZonalHarmonic[] = [];
  for (const id of Object.keys(pairs)) {
    const i = bodyIndex(id, bodies);
    const ob = oblatenessOf(bodies[i], fixedPole);
    if (ob === null) throw new Error(`${id} has no J2 data`);
    const targets = pairs[id].map((t) => bodyIndex(t, bodies));
    const sel = fixedPole ? undefined : fields[id];
    const f = sel !== undefined ? truncateField(ob, sel) : { j2: ob.j2, ...(ob.j4 !== undefined ? { j4: ob.j4 } : {}) };
    const z: ZonalHarmonic = { body: i, ...f, radius: ob.radius, pole: ob.pole, targets };
    if (ob.rotation !== undefined) z.rotation = ob.rotation;
    if (f.tesseral !== undefined && ob.primeMeridian !== undefined) z.primeMeridian = ob.primeMeridian;
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
  saturn: ['sun', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus'],
  uranus: ['sun', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon'],
  neptune: ['sun', 'triton'],
};

/**
 * Which part of each body's field acts between massive bodies (the pairs of
 * MASSIVE_BODY_J2_PAIRS); bodies not listed: J2 and J4. Set by measurement
 * (stage 2 of model 2), each term against its effect on the bodies it acts on:
 *  - Saturn J3..J8 on its moons: Mimas 372 -> 157 km and Enceladus 59 -> 19 km
 *    off Horizons after 1 yr, Tethys 104 -> 94, Dione 3.4 -> 2.3 (J8 adds 4 km
 *    for Mimas over J6; the data stops at J9, which is 1e-6).
 *  - Jupiter J3..J6 on the Galileans: Io 144.9 -> 143.0 km, Europa 6.1 -> 5.7
 *    (J7, J8: no change at 0.1 km).
 *  - Left out, effect below the noise: Uranus and Neptune J6 on their moons
 *    (< 0.1 km/yr); Earth J3, J4 on the Moon (31 m after 100 yr) and Moon J3,
 *    J4 on Earth (5 m); Earth's tesserals (42 m: they average out over a day).
 *  - Left out, NOT negligible: the Moon's C22 and higher tesserals moved the
 *    Moon by 108 km (degree 2) and 191 km (degree 4) after 100 yr, but made the
 *    agreement with DE441 worse (Earth-relative 418 -> 526 / 609 km). Their
 *    effect hinges on the Moon's orientation: shifting its prime meridian by
 *    0.01 deg moves the Moon 50-90 km, and the IAU libration series (Earth-
 *    pointing to ~0.01-0.1 deg; DE440 integrates the librations) is not good
 *    enough. A lunar libration integration would be needed first.
 */
export const MASSIVE_BODY_FIELDS: Readonly<Record<string, MassiveFieldSelection>> = {
  saturn: { degree: 8 },
  jupiter: { degree: 6 },
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
  opts: { fixedPoles?: boolean; fields?: Readonly<Record<string, MassiveFieldSelection>> } = {},
): NBodyPhysics {
  const ids = new Set(bodies.map((b) => b.id));
  const present: Record<string, readonly string[]> = {};
  for (const id of Object.keys(pairs)) if (ids.has(id)) present[id] = pairs[id].filter((t) => ids.has(t));
  return { zonal: zonalTerms(present, bodies, opts.fixedPoles === true, opts.fields ?? MASSIVE_BODY_FIELDS), relativity: { sun: bodyIndex('sun', bodies) } };
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
