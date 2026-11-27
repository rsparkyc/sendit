/**
 * Example launch vehicles, as data: APPROXIMATIONS built from public figures
 * (sources per vehicle; mostly Wikipedia infoboxes, which cite the
 * operators' user's guides; not checked against the guides themselves).
 * Engine thrust and Isp are vacuum values. Parallel boosters are given as
 * their serial equivalent: stage 0 is "boosters plus the core's propellant
 * burned alongside them" (the rocket equation sees only mass flow, so this is
 * exact for constant thrust), stage 1 the core's remainder. The payload
 * fairing is counted in the first stage's dry mass (dropped at staging; real
 * fairings go a little later). Each vehicle is the lower stages only: put a
 * spacecraft on top with `withSpacecraft`.
 *
 * These calibrate and validate the ascent model (test/ascent-validation.test.ts)
 * and are what part three chooses mission vehicles from.
 */
import { SOLID, type Engine, type Stage } from './plan';

export interface VehicleSpec {
  readonly id: string;
  readonly name: string;
  readonly class: 'small' | 'medium' | 'heavy';
  /** Lower stages, firing order (no spacecraft). */
  readonly stages: readonly Stage[];
  readonly notes: string;
  readonly sources: readonly string[];
}

const eng = (thrust: number, isp: number): Engine => ({ thrust, isp });
const stage = (propellant: number, dryMass: number, engines: Engine[]): Stage => ({ wetMass: propellant + dryMass, dryMass, engines });

/** Serial-equivalent first stage of boosters + core firing together for `boosterBurnS`. */
function parallelStage(boosters: { prop: number; dry: number; engine: Engine }, core: Engine, boosterBurnS: number, fairing: number): { first: Stage; coreBurned: number } {
  const coreBurned = (core.thrust / (core.isp * 9.80665)) * boosterBurnS;
  return { first: stage(boosters.prop + coreBurned, boosters.dry + fairing, [boosters.engine, core]), coreBurned };
}

const soyuz = parallelStage({ prop: 4 * 39160, dry: 4 * 3784, engine: eng(4 * 1021.3e3, 319) }, eng(990.2e3, 319), 118, 0);
const ariane = parallelStage({ prop: 2 * 240000, dry: 2 * 33000, engine: eng(2 * 4615e3, 274.5) }, eng(1390e3, 432), 140, 2400);

export const VEHICLES: readonly VehicleSpec[] = [
  {
    id: 'falcon-9',
    name: 'Falcon 9 Block 5 (expendable, approximate)',
    class: 'medium',
    stages: [stage(410900, 22200 + 1900, [eng(9 * 914e3, 311)]), stage(107500, 4000, [eng(981e3, 348)])],
    notes: 'Two-stage kerosene medium launcher. Stage 1: 9 Merlin 1D at the 914 kN vacuum figure, 311 s; fairing (~1.9 t, approximate) with stage 1. Stage 2: Merlin Vacuum 981 kN, 348 s.',
    sources: ['https://en.wikipedia.org/wiki/Falcon_9_Block_5', 'https://en.wikipedia.org/wiki/SpaceX_Merlin'],
  },
  {
    id: 'atlas-v-401',
    name: 'Atlas V 401 (approximate)',
    class: 'medium',
    stages: [stage(284089, 21054 + 2100, [eng(4152e3, 337.8)]), stage(20830, 2316, [eng(99.2e3, 450.5)])],
    notes: 'Kerosene core (RD-180) and a hydrogen Centaur (one RL10) with low thrust-to-weight. 4 m fairing ~2.1 t (approximate) with stage 1.',
    sources: ['https://en.wikipedia.org/wiki/Atlas_V'],
  },
  {
    id: 'ariane-5-eca',
    name: 'Ariane 5 ECA (approximate)',
    class: 'heavy',
    stages: [ariane.first, stage(170000 - ariane.coreBurned, 14700, [eng(1390e3, 432)]), stage(14900, 4540, [eng(67e3, 446)])],
    notes: 'Heavy launcher with a high-energy (hydrogen) upper stage, ESC-A. Two P241 boosters (240 t each, 140 s; average thrust 4615 kN from 274.5 s Isp, an assumed value) with the Vulcain 2 core in parallel, given serially. Fairing ~2.4 t (approximate).',
    sources: ['https://en.wikipedia.org/wiki/Ariane_5'],
  },
  {
    id: 'soyuz-2-1b',
    name: 'Soyuz-2.1b (approximate)',
    class: 'medium',
    stages: [soyuz.first, stage(90100 - soyuz.coreBurned, 6545, [eng(990.2e3, 319)]), stage(25400, 2355, [eng(294.3e3, 359)])],
    notes: 'Four RD-107A boosters with the RD-108A core in parallel (given serially), RD-0124 third stage. Fairing not modelled separately.',
    sources: ['https://en.wikipedia.org/wiki/Soyuz-2', 'https://en.wikipedia.org/wiki/Soyuz_at_the_Guiana_Space_Centre'],
  },
  {
    id: 'electron',
    name: 'Electron (rough estimate)',
    class: 'small',
    stages: [stage(9250, 950, [eng(234e3, 311)]), stage(2050, 250, [eng(25.8e3, 343)])],
    notes: 'Small launcher. Thrust and Isp public; the stage masses are NOT published: split of the 13.0 t liftoff mass ESTIMATED here. Treat as illustrative.',
    sources: ['https://en.wikipedia.org/wiki/Rocket_Lab_Electron'],
  },
];

const solid = (propellant: number, dryMass: number, thrust: number, isp: number): Stage => ({ wetMass: propellant + dryMass, dryMass, engines: [{ thrust, isp, ...SOLID }] });

/**
 * All-solid vehicles (every engine non-restartable and non-throttleable), for
 * direct injection. Kept OUT of VEHICLES so the pinned ascent cases and the
 * payload calibration (which loop over VEHICLES) are unchanged.
 */
export const SOLID_VEHICLES: readonly VehicleSpec[] = [
  {
    id: 'minotaur-v',
    name: 'Minotaur V (all solid, APPROXIMATE)',
    class: 'small',
    stages: [
      solid(45400, 3600 + 500, 2224e3, 286),
      solid(24500, 3300, 1223e3, 308),
      solid(6170, 1120, 289e3, 300),
      solid(2010, 154 + 300, 68.6e3, 288),
      solid(1066, 82, 54.8e3, 290),
    ],
    notes: 'Five solid stages: SR-118, SR-119, SR-120 (Peacekeeper), Star 48BV, Star 37FM. Thrust and Isp from the Minotaur V article (SR-118 Isp taken as ~286 s vacuum, the article quotes 229 s); propellant and dry masses are APPROXIMATE public figures for the motors (Peacekeeper stages, ATK Star motor catalogue values as remembered, not checked against the catalogue); fairing ~0.5 t with stage 1; ~0.3 t of guidance, avionics and structure (assumed) with stage 4. Total ~89.1 t against the published 89.4 t liftoff. Published capability: 342 kg to TLI (flew LADEE, 2013, from Wallops).',
    sources: ['https://en.wikipedia.org/wiki/Minotaur_V', 'https://en.wikipedia.org/wiki/LGM-118_Peacekeeper'],
  },
];

export function vehicleSpec(id: string): VehicleSpec {
  const v = VEHICLES.find((x) => x.id === id) ?? SOLID_VEHICLES.find((x) => x.id === id);
  if (!v) throw new Error(`unknown vehicle ${id}`);
  return v;
}

/** The vehicle's stages with a spacecraft on top (the plan's full stack). */
export function withSpacecraft(v: VehicleSpec, spacecraft: Stage): Stage[] {
  return [...v.stages, spacecraft];
}

/** A catalogue vehicle's lower stages as fresh plain data (mission rules keep their own copy). */
export function catalogueStages(id: string): Stage[] {
  return vehicleSpec(id).stages.map((s) => ({ wetMass: s.wetMass, dryMass: s.dryMass, engines: s.engines.map((e) => ({ ...e })) }));
}

/**
 * Parking-orbit altitudes the campaign allows (rules.vehicle), m: from 180 km
 * (the lowest orbit that stays clear of the 122 km atmosphere top through the
 * J2 wobble and the oblate surface) to 1 000 km. Lower is cheaper to reach;
 * the ascent model charges every kilometre above.
 */
export const PARKING_BAND: readonly [number, number] = [180e3, 1000e3];
