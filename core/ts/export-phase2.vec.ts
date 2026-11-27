/**
 * Phase-two parity vectors for the Rust core (see core/README.md): the
 * massive-body integrator, the chunk builder and checkpoint asset, and the
 * mission layer (plan decoding, launch, ascent, events, replay, objectives,
 * scoring). Same format as export-vectors.vec.ts (numbers as 16 hex digits of
 * their float64 bits), written to core/fixtures/generated/ (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { DEFAULT_STEP, J2000_BODIES, bodyIndex, solarSystemPhysics } from '../../src/physics/solar-system';
import { IAU_ROTATION } from '../../src/physics/orientation';
import { KAHAN_LI_8, LEAPFROG, NBodyIntegrator, type NBodyPhysics, type ZonalHarmonic } from '../../src/physics/nbody';
import { Lines, zonalTermRecord } from './shared';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ASSET = new URL('../../src/physics/data/checkpoints-1950-2100.bin', import.meta.url);
const assetBytes = () => new Uint8Array(readFileSync(ASSET));

/** FNV-style digest of float64 bits (the golden-test Digest). */
export class Digest {
  private h1 = 0x811c9dc5;
  private h2 = 0x9747b28c;
  private n = 0;
  private readonly f = new Float64Array(1);
  private readonly u = new Uint32Array(this.f.buffer);
  add(x: number): void {
    this.f[0] = x;
    for (let i = 0; i < 2; i++) {
      const w = this.u[i];
      this.h1 = Math.imul(this.h1 ^ w, 0x01000193) >>> 0;
      this.h2 = Math.imul((this.h2 ^ w) + 0x9e3779b9, 0x85ebca6b) >>> 0;
      this.h2 = (this.h2 ^ (this.h2 >>> 13)) >>> 0;
    }
    this.n++;
  }
  addAll(a: ArrayLike<number>): void {
    for (let i = 0; i < a.length; i++) this.add(a[i]);
  }
  hex(): string {
    return `${this.n}:${this.h1.toString(16).padStart(8, '0')}${this.h2.toString(16).padStart(8, '0')}`;
  }
}

describe('phase 2: massive bodies and chunks', () => {
  it('n-body integrator steps', () => {
    const L = new Lines();
    const gm = J2000_BODIES.map((b) => b.gm);
    const n = gm.length;
    const state0 = new Float64Array(6 * n);
    J2000_BODIES.forEach((b, i) => state0.set(b.state, 6 * i));
    const full = solarSystemPhysics(J2000_BODIES);
    const earth = J2000_BODIES[bodyIndex('earth')];
    // Earth's full field (degree 4 with tesserals, ERA frame) on the Moon: the BodyFrame path, unused by the production physics.
    const tess: ZonalHarmonic = {
      body: bodyIndex('earth'), j2: earth.j2!, jn: earth.jn!, tesseral: earth.tesseral!.map((r) => [r[0], r[1], r[2], r[3]] as const),
      primeMeridian: 'earth-rotation-angle', radius: earth.j2Radius!, pole: [earth.pole![0], earth.pole![1], earth.pole![2]], rotation: IAU_ROTATION.earth, targets: [bodyIndex('moon')],
    };
    // A zonal series on a fixed pole (jn without a rotation model) and a J2+J4 closed form.
    const fixedJn: ZonalHarmonic = { body: bodyIndex('saturn'), j2: J2000_BODIES[bodyIndex('saturn')].j2!, jn: J2000_BODIES[bodyIndex('saturn')].jn!.slice(0, 5), radius: J2000_BODIES[bodyIndex('saturn')].j2Radius!, pole: [0.1, -0.2, Math.sqrt(0.95)], targets: [bodyIndex('titan'), bodyIndex('rhea')] };
    const j4: ZonalHarmonic = { body: bodyIndex('jupiter'), j2: 1.4736e-2, j4: -5.87e-4, radius: 71492e3, pole: [0, 0, 1], targets: [bodyIndex('io'), bodyIndex('sun')] };
    const cases: { name: string; scheme: 'kl8' | 'leapfrog'; physics: NBodyPhysics; h: number; t0: number; boundary?: number; steps: number }[] = [
      { name: 'newton', scheme: 'kl8', physics: {}, h: DEFAULT_STEP, t0: 0, steps: 12 },
      { name: 'leapfrog', scheme: 'leapfrog', physics: {}, h: DEFAULT_STEP, t0: 0, steps: 12 },
      { name: 'zonal-backward', scheme: 'kl8', physics: { zonal: full.zonal }, h: -DEFAULT_STEP, t0: 0, steps: 12 },
      { name: 'extra-terms', scheme: 'kl8', physics: { zonal: [tess, fixedJn, j4] }, h: DEFAULT_STEP, t0: 0, steps: 12 },
      { name: 'extra-terms-rel', scheme: 'kl8', physics: { zonal: [tess, fixedJn, j4], relativity: full.relativity }, h: -DEFAULT_STEP, t0: 0, steps: 8 },
      { name: 'full', scheme: 'kl8', physics: full, h: DEFAULT_STEP, t0: 0, steps: 12 },
      { name: 'full-resumed', scheme: 'kl8', physics: full, h: DEFAULT_STEP, t0: 0, boundary: 77, steps: 12 },
      { name: 'full-resumed-backward', scheme: 'kl8', physics: full, h: -DEFAULT_STEP, t0: 0, boundary: -120, steps: 12 },
    ];
    const eph = new ChebyshevEphemeris(J2000_BODIES);
    installCheckpointAsset(eph, J2000_BODIES, assetBytes());
    const acc = new Float64Array(3 * n);
    for (const c of cases) {
      const zonal = c.physics.zonal ?? [];
      L.add('nbcase', c.name, c.scheme, c.t0, c.h, c.boundary ?? 0, c.physics.relativity ? c.physics.relativity.sun : -1, zonal.length);
      for (const Z of zonal) L.add(...zonalTermRecord(Z));
      const it = new NBodyIntegrator(gm, state0, c.t0, c.h, c.scheme === 'kl8' ? KAHAN_LI_8 : LEAPFROG, c.physics);
      if (c.boundary !== undefined) it.importState(eph.checkpoint(c.boundary)!.data, Math.abs(c.boundary) * eph.layout.chunkSteps);
      it.totalAcceleration(acc);
      L.add('nbstep', it.t, it.exportState(), acc);
      for (let s = 0; s < c.steps; s++) {
        it.step();
        it.totalAcceleration(acc);
        L.add('nbstep', it.t, it.exportState(), acc);
      }
      L.add('nbend');
    }
    writeFileSync(OUT + 'nbody.txt', L.text());
  });

  it('chunks built from the checkpoint asset', () => {
    const eph = new ChebyshevEphemeris(J2000_BODIES);
    installCheckpointAsset(eph, J2000_BODIES, assetBytes());
    const C = eph.layout.chunkSpan;
    const L = new Lines();
    const cps = eph.checkpoints();
    L.add('asset', cps[0].boundary, cps[cps.length - 1].boundary);
    const ks = [-144, -143, -142, -100, -57, -4, -1, 0, 3, 77, 80, 81, 150, 284, 285, 286];
    for (const k of ks) {
      eph.ensure(k * C, k * C);
      const c = eph.getChunk(k)!;
      writeFileSync(`${OUT}chunkA_${k}.bin`, new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
      const d = new Digest();
      d.addAll(c);
      L.add('chunk', k, 'digest', d.hex());
    }
    writeFileSync(OUT + 'chunks.txt', L.text());
  });
});
