/** Shared by the data generator and the vector exporters (core/ts/*.vec.ts). */
import type { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { IAU_ROTATION, POLE_NODE_SPACING } from '../../src/physics/orientation';
import { J2000_BODIES } from '../../src/physics/solar-system';
import type { ZonalHarmonic } from '../../src/physics/nbody';

const dv = new DataView(new ArrayBuffer(8));
export function hx(x: number): string {
  dv.setFloat64(0, x);
  return dv.getUint32(0).toString(16).padStart(8, '0') + dv.getUint32(4).toString(16).padStart(8, '0');
}
export class Lines {
  readonly l: string[] = [];
  add(...parts: (string | number | ArrayLike<number>)[]): void {
    this.l.push(parts.map((p) => (typeof p === 'string' ? p : typeof p === 'number' ? hx(p) : Array.from(p).map(hx).join(' '))).join(' '));
  }
  text(): string {
    return this.l.join('\n') + '\n';
  }
}

/** A zonal term in the record encoding core/src/fixture.rs reads (shared with the vector exporter). */
export function zonalTermRecord(Z: ZonalHarmonic): (string | number | ArrayLike<number>)[] {
  const rotId = Z.rotation ? Object.keys(IAU_ROTATION).find((k) => IAU_ROTATION[k] === Z.rotation) ?? 'custom' : 'none';
  if (rotId === 'custom') throw new Error('zonal term with a rotation model not in IAU_ROTATION');
  const jn = Z.jn ?? [];
  const tess = Z.tesseral ?? [];
  return [
    'zonalterm', Z.body, Z.j2, Z.j4 !== undefined ? 'j4' : 'noj4', Z.j4 ?? 0, Z.jn !== undefined ? 'jn' : 'nojn', jn.length, jn,
    Z.tesseral !== undefined ? 'tess' : 'notess', tess.length, tess.flat(), Z.primeMeridian ?? 'iau', Z.radius, Z.pole, rotId,
    Z.poleSpacing ?? POLE_NODE_SPACING, Z.targets.length, Z.targets,
  ];
}

/** World description: models, layout, spacecraft force model, massive-body physics, initial states. */
export function worldRecords(eph: ChebyshevEphemeris, W: Lines): void {
  const N = J2000_BODIES.length;
  for (const id of Object.keys(IAU_ROTATION)) {
    const m = IAU_ROTATION[id];
    const nut = m.nut ?? [];
    const pad = (a: readonly number[]) => [a[0], a[1] ?? 0, a[2] ?? 0];
    W.add('model', id, m.naifId, pad(m.ra), pad(m.dec), pad(m.pm), nut.length, nut.flatMap((n) => [...pad(n.angle), n.ra, n.dec, n.pm]));
  }
  const Ly = eph.layout;
  W.add('layout', Ly.count, Ly.h, Ly.chunkSteps, Ly.chunkSpan, eph.t0, Ly.chunkLength);
  const arr = (name: string, a: ArrayLike<number>) => W.add('array', name, a.length, a);
  arr('segLen', Ly.segLen);
  arr('twoOverLen', Ly.twoOverLen);
  arr('segCount', Ly.segCount);
  arr('offset', Ly.offset);
  arr('stride3', Ly.stride3);
  arr('degree', Ly.degree);
  arr('center', Ly.center);
  arr('weight', Ly.weight);
  arr('sysPlanet', Ly.sysPlanet);
  arr('sysStart', Ly.sysStart);
  arr('sysMoons', Ly.sysMoons);
  arr('systemOf', Ly.systemOf);
  arr('samples', Ly.samples);
  arr('sampleStride', Ly.sampleStride);
  arr('gm', eph.gm);
  for (let i = 0; i < N; i++) {
    const ob = eph.oblateness[i];
    if (ob === null) {
      W.add('body', J2000_BODIES[i].id, i, 'none');
      continue;
    }
    const rotId = ob.rotation ? Object.keys(IAU_ROTATION).find((k) => IAU_ROTATION[k] === ob.rotation)! : 'none';
    const jn = ob.jn ?? [];
    const tess = ob.tesseral ?? [];
    W.add('body', J2000_BODIES[i].id, i, 'field', ob.j2, ob.j4 ?? 0, ob.j4 !== undefined ? 'j4' : 'noj4', ob.radius, ob.pole, rotId, ob.primeMeridian ?? 'iau',
      ob.taper ? 'taper' : 'notaper', ob.taper ? [ob.taper[0], ob.taper[1]] : [0, 0], jn.length, jn, tess.length, tess.flat());
  }
  W.add('relativity', eph.relativity ? eph.relativity.body : -1);
  for (const Z of eph.physics.zonal ?? []) W.add(...zonalTermRecord(Z));
  W.add('nbodyrelativity', eph.physics.relativity ? eph.physics.relativity.sun : -1);
  W.add('initial', N, J2000_BODIES.flatMap((b) => [...b.state]));
}

/** JSON with exact numbers: -0 kept, non-finite refused. */
export function exactJson(v: unknown, indent = ''): string {
  const next = indent + ' ';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number ${v} in data`);
    return Object.is(v, -0) ? '-0' : String(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<unknown>);
    if (a.every((x) => typeof x === 'number')) return `[${a.map((x) => exactJson(x)).join(', ')}]`;
    return `[\n${a.map((x) => next + exactJson(x, next)).join(',\n')}\n${indent}]`;
  }
  if (typeof v === 'object') {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (e.length === 0) return '{}';
    return `{\n${e.map(([k, x]) => `${next}${JSON.stringify(k)}: ${exactJson(x, next)}`).join(',\n')}\n${indent}}`;
  }
  throw new Error(`cannot encode ${typeof v}`);
}

