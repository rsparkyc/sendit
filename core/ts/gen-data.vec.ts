/**
 * Generates the Rust core's built-in data from the TypeScript sources, so the
 * tables cannot drift from them (nothing is copied by hand):
 *   core/data/world.txt         bodies, IAU rotation models, ephemeris layout,
 *                               spacecraft force model, massive-body physics,
 *                               initial states (the fixture world.txt format,
 *                               numbers as float64 bit patterns);
 *   core/data/mission-data.json launch sites, ascent constants, WGS84, the
 *                               Earth rotation model, world fingerprint, the
 *                               campaign definitions and vehicles.
 * Both are checked in (the Rust embeds them with include_str!). Run by
 * `pnpm core:vectors`; core/scripts/test.sh fails if regenerating changes them.
 *
 * JSON numbers are JavaScript's shortest round-trip form, which Rust parses
 * back to the same bits; -0 is written as "-0", and a non-finite number is
 * refused (none occurs in the data).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { exactJson, Lines, worldRecords } from './shared';
import { it } from 'vitest';
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { checkpointVersion } from '../../src/physics/checkpoint-asset';
import { IAU_ROTATION } from '../../src/physics/orientation';
import { EARTH_ROTATION } from '../../src/physics/earth-rotation';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { ATMOSPHERE_HEIGHT, PHYSICS_MODEL, worldFromBodyData } from '../../src/mission/world';
import { LAUNCH_SITES, DEFAULT_ASCENT_TIME_S, DEFAULT_DOWNRANGE_DEG } from '../../src/mission/launch';
import { ASCENT_BODIES } from '../../src/mission/ascent';
import { WGS84 } from '../../src/mission/earth-orientation';
import { CAMPAIGN } from '../../src/mission/campaign';
import { VEHICLES, SOLID_VEHICLES, PARKING_BAND } from '../../src/mission/vehicles';
import { LIMITS, MAX_PARKING_ALTITUDE, DIRECT_C3_RANGE, DIRECT_ALTITUDE_RANGE, DIRECT_PARAMS } from '../../src/mission/plan';
import { BISECT_MAX, NODES } from '../../src/mission/events';

const DATA = new URL('../data/', import.meta.url).pathname;
mkdirSync(DATA, { recursive: true });

it('generate core/data', () => {
  const eph = new ChebyshevEphemeris(J2000_BODIES);
  const W = new Lines();
  worldRecords(eph, W);
  writeFileSync(DATA + 'world.txt', W.text());

  const world = worldFromBodyData(eph, J2000_BODIES);
  const rot = (id: string) => (Object.prototype.hasOwnProperty.call(IAU_ROTATION, id) ? id : null);
  const data = {
    physicsModel: PHYSICS_MODEL,
    fingerprint: world.fingerprint,
    checkpointVersion: checkpointVersion(eph, J2000_BODIES),
    bodies: J2000_BODIES.map((b) => ({
      id: b.id, gm: b.gm, radius: b.radius, referenceRadius: b.referenceRadius, atmosphere: ATMOSPHERE_HEIGHT[b.id] ?? 0,
      pole: b.pole ? [b.pole[0], b.pole[1], b.pole[2]] : null, rotation: rot(b.id), j2: b.j2 ?? null, j2Radius: b.j2Radius ?? null,
    })),
    earthRotation: { ra0: EARTH_ROTATION.ra0, ra1: EARTH_ROTATION.ra1, dec0: EARTH_ROTATION.dec0, dec1: EARTH_ROTATION.dec1, w0: EARTH_ROTATION.w0, wDot: EARTH_ROTATION.wDot, w1: EARTH_ROTATION.w1 ?? 0 },
    wgs84: { a: WGS84.a, f: WGS84.f },
    launch: { defaultAscentTimeS: DEFAULT_ASCENT_TIME_S, defaultDownrangeDeg: DEFAULT_DOWNRANGE_DEG, maxParkingAltitude: MAX_PARKING_ALTITUDE },
    sites: LAUNCH_SITES.map((s) => ({ id: s.id, latDeg: s.latDeg, lonDeg: s.lonDeg, heightM: s.heightM, azimuthMinDeg: s.azimuthMinDeg, azimuthMaxDeg: s.azimuthMaxDeg })),
    ascentBodies: ASCENT_BODIES,
    planLimits: { ...LIMITS, directC3Range: DIRECT_C3_RANGE, directAltitudeRange: DIRECT_ALTITUDE_RANGE, directParams: DIRECT_PARAMS },
    events: { nodes: NODES, bisectMax: BISECT_MAX },
    parkingBand: PARKING_BAND,
    vehicles: [...VEHICLES, ...SOLID_VEHICLES].map((v) => ({ id: v.id, stages: v.stages })),
    campaign: CAMPAIGN,
  };
  writeFileSync(DATA + 'mission-data.json', exactJson(data) + '\n');
});
