/**
 * The mission layer's view of the bodies: ephemeris plus, per body, an id,
 * radius, atmosphere height and spin axis, and a fingerprint of everything a
 * replay depends on, so a plan made against other data can be detected.
 *
 * Bodies are always looked up by id (`bodyIndexOf`), never by position: the
 * physics body list grows (moons are being added).
 */
import { earthRotationConstants } from '../physics/earth-rotation';
import { IAU_ROTATION } from '../physics/orientation';
import type { BodyData } from '../physics/solar-system';
import type { Ephemeris } from '../physics/spacecraft';
import { Hasher } from './exact-math';

/**
 * Version of the physics MODEL (force model, integrator, event finder) that a
 * plan is replayed with. Bump by hand whenever code changes could change replay
 * results; data changes are caught by the fingerprint automatically.
 */
export const PHYSICS_MODEL = 2;
// Model history:
//  1: fixed J2000 poles for every zonal field.
//  2: time-dependent IAU poles (src/physics/orientation.ts) in the massive-body
//     integrator and the spacecraft; Miranda modelled; Moon parented to Earth;
//     outer moons no longer lumped into their planet's GM (Pluto, Saturn).

/**
 * Atmosphere-top altitudes above the mean radius used by the physics data,
 * in metres. Crossing this altitude counts as atmospheric entry (there is no
 * aerodynamic model, so entry ends the flight). Values are the conventional
 * "entry interface" altitudes of real missions (values as commonly published
 * for those missions; check before relying on them for anything but gameplay):
 *  - earth 122 km: the 400 000 ft entry interface used by Apollo and the Shuttle.
 *  - mars 125 km: Mars Science Laboratory entry interface radius 3522.2 km less
 *    the 3389.5 km mean radius, rounded.
 *  - venus 200 km: Pioneer Venus multiprobe entry altitude.
 *  - jupiter 450 km above the 1-bar level: Galileo probe entry interface.
 *  - titan 1270 km: Huygens entry interface.
 * Saturn, Uranus and Neptune have deep atmospheres too, but no flown entry
 * interface to cite; they are left at 0 (surface radius only) for now.
 */
export const ATMOSPHERE_HEIGHT: Readonly<Record<string, number>> = {
  venus: 200e3,
  earth: 122e3,
  mars: 125e3,
  jupiter: 450e3,
  titan: 1270e3,
};

export interface MissionBody {
  readonly id: string;
  /** Surface (mean) radius, m. */
  readonly radius: number;
  /** Atmosphere top above the radius, m; 0 for none. */
  readonly atmosphere: number;
  /** Spin-axis unit vector in the ephemeris frame, if known. */
  readonly pole: readonly [number, number, number] | null;
}

export interface MissionWorld {
  readonly ephemeris: Ephemeris;
  /** Same order as the ephemeris. */
  readonly bodies: readonly MissionBody[];
  /** 8 hex digits: hash of PHYSICS_MODEL, body table and the data given to makeWorld. */
  readonly fingerprint: string;
  /** Physics body data the ephemeris was built from, when there is one (needed for launch starts). */
  readonly bodyData?: readonly BodyData[];
}

/**
 * Build a world. `data` is any additional numbers the ephemeris depends on
 * (initial states, J2, ...) to fold into the fingerprint.
 */
export function makeWorld(ephemeris: Ephemeris, bodies: readonly MissionBody[], data: ArrayLike<number> = []): MissionWorld {
  if (bodies.length !== ephemeris.count) {
    throw new Error(`world: ${bodies.length} bodies for an ephemeris with ${ephemeris.count}`);
  }
  const ids = new Set<string>();
  const h = new Hasher().u32(PHYSICS_MODEL).u32(bodies.length);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (ids.has(b.id)) throw new Error(`world: duplicate body id ${b.id}`);
    ids.add(b.id);
    h.str(b.id).f64(ephemeris.gm[i]).f64(b.radius).f64(b.atmosphere);
    if (b.pole) h.f64(b.pole[0]).f64(b.pole[1]).f64(b.pole[2]);
  }
  h.u32(data.length);
  for (let i = 0; i < data.length; i++) h.f64(data[i]);
  return { ephemeris, bodies, fingerprint: h.hex().slice(0, 8) };
}

/** World for an ephemeris built from physics BodyData (e.g. ChebyshevEphemeris(J2000_BODIES)). */
export function worldFromBodyData(ephemeris: Ephemeris, data: readonly BodyData[]): MissionWorld {
  const bodies = data.map((b): MissionBody => ({
    id: b.id,
    radius: b.radius,
    atmosphere: ATMOSPHERE_HEIGHT[b.id] ?? 0,
    pole: b.pole ? [b.pole[0], b.pole[1], b.pole[2]] : null,
  }));
  const extra: number[] = [];
  for (const b of data) {
    extra.push(...b.state, b.j2 ?? 0, b.j2Radius ?? 0, b.j4 ?? 0);
    // The pole model the zonal field turns with (physics model 2).
    const r = b.j2 !== undefined ? IAU_ROTATION[b.id] : undefined;
    if (r) {
      extra.push(...r.ra, ...r.dec);
      for (const n of r.nut ?? []) extra.push(...n.angle, n.ra, n.dec);
      // Prime meridian (tesseral fields turn with it), incl. its libration terms.
      extra.push(...r.pm);
      for (const n of r.nut ?? []) extra.push((n as { pm?: number }).pm ?? 0);
    }
    // Higher zonals and tesserals (stage 2 of model 2).
    for (const j of b.jn ?? []) extra.push(j);
    for (const t of b.tesseral ?? []) extra.push(...t);
    for (const k of b.fieldTaper ?? []) extra.push(k); // spacecraft taper radii (body radii)
  }
  extra.push(...earthRotationConstants());
  return { ...makeWorld(ephemeris, bodies, extra), bodyData: data };
}

export function bodyIndexOf(world: MissionWorld, id: string): number {
  for (let i = 0; i < world.bodies.length; i++) if (world.bodies[i].id === id) return i;
  return -1;
}
