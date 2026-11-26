import { describe, expect, it } from 'vitest';
import { deriveMeta } from './body-meta';
import { anchorSegments, bodyPath, trajectoryPath, type FrameContext } from './paths';
import { BODIES, Ephemeris, ReplayEphemeris } from './physics';
import { stateAt, trajectoryFrom } from './trajectory';

/** Body 0 fixed at a large offset (like the Sun far from a planet), body 1 circling it with period 2*pi. */
const OFFSET = 7.5e12;
const ctx: FrameContext = {
  count: 2,
  gm: [1, 1e-6],
  evaluate(t, pos, vel) {
    if (t < -100 || t > 100) return false;
    pos.set([OFFSET, 0, 0, OFFSET + 1e8 * Math.cos(t), 1e8 * Math.sin(t), 0]);
    vel.set([0, 0, 0, -1e8 * Math.sin(t), 1e8 * Math.cos(t), 0]);
    return true;
  },
};

describe('paths', () => {
  it('body path in a centred inertial frame is a circle; in the rotating frame a point', () => {
    const p = bodyPath(ctx, { kind: 'inertial', center: 0 }, 1, 0, 2 * Math.PI, 64);
    for (let i = 0; i < p.times.length; i++) {
      // Ecliptic axes tilt the circle, but the radius is preserved.
      expect(Math.hypot(p.points[3 * i], p.points[3 * i + 1], p.points[3 * i + 2])).toBeCloseTo(1e8, 1);
    }
    const r = bodyPath(ctx, { kind: 'rotating', center: 0, secondary: 1 }, 1, 0, 2 * Math.PI, 64);
    for (let i = 0; i < r.times.length; i++) {
      expect(r.points[3 * i]).toBeCloseTo(1e8, 1);
      expect(Math.abs(r.points[3 * i + 1])).toBeLessThan(1e-2);
    }
  });

  it('drops samples outside ephemeris coverage', () => {
    const p = bodyPath(ctx, { kind: 'barycentric' }, 1, 50, 150, 100);
    expect(p.times.length).toBe(51);
    expect(p.times[p.times.length - 1]).toBe(100);
  });

  it('trajectory samples transform with the frame at their own time', () => {
    // A craft riding 1000 m "above" body 1 radially: in the rotating frame it sits at x = 1e8 + 1000.
    const data: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i * 0.1;
      const r = 1e8 + 1000;
      data.push(t, OFFSET + r * Math.cos(t), r * Math.sin(t), 0, -r * Math.sin(t), r * Math.cos(t), 0);
    }
    const tr = trajectoryFrom(Float64Array.from(data));
    const fp = trajectoryPath(ctx, { kind: 'rotating', center: 0, secondary: 1 }, tr);
    for (let i = 0; i < fp.times.length; i++) {
      expect(fp.points[3 * i]).toBeCloseTo(1e8 + 1000, 1);
      expect(Math.abs(fp.points[3 * i + 1])).toBeLessThan(1e-2);
    }
  });

  it('anchored float32 segments keep metre precision far from the origin', () => {
    // A 300 km path at 50 AU, 1 m spacing.
    const N = 1001;
    const pts = new Float64Array(3 * N);
    for (let i = 0; i < N; i++) pts.set([7.5e12 + i * 300, 1e5, 3], 3 * i);
    const segs = anchorSegments(pts, 1000, 256);
    let v = 0;
    let worst = 0;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      const count = seg.verts.length / 3;
      for (let j = s === 0 ? 0 : 1; j < count; j++, v++) {
        const x = seg.anchor[0] + seg.verts[3 * j] * 1000;
        worst = Math.max(worst, Math.abs(x - pts[3 * v]));
      }
    }
    expect(v).toBe(N);
    expect(worst).toBeLessThan(0.01); // vs ~500 km if stored as float32 absolute
    // Consecutive segments share endpoints.
    expect(segs[1].anchor[0]).toBe(pts[3 * 255]);
  });
});

describe('trajectory interpolation', () => {
  it('cubic Hermite is exact for cubics and gives the derivative', () => {
    const f = (t: number) => 2 * t * t * t - t * t + 3 * t + 1;
    const df = (t: number) => 6 * t * t - 2 * t + 3;
    const data: number[] = [];
    for (const t of [0, 0.7, 2, 3.1]) data.push(t, f(t), 0, 0, df(t), 0, 0);
    const tr = trajectoryFrom(Float64Array.from(data));
    const out = new Float64Array(6);
    for (const t of [0, 0.3, 1.4, 2.9, 3.1]) {
      expect(stateAt(tr, t, out)).toBe(true);
      expect(out[0]).toBeCloseTo(f(t), 10);
      expect(out[3]).toBeCloseTo(df(t), 10);
    }
    expect(stateAt(tr, 3.2, out)).toBe(false);
  });
});

describe('body metadata from the real data', () => {
  it('derives parents and periods without assuming body order', () => {
    const meta = deriveMeta(BODIES);
    const id = (i: number) => (i < 0 ? null : BODIES[i].id);
    const by = (bid: string) => meta[BODIES.findIndex((b) => b.id === bid)];
    expect(id(by('sun').parent)).toBeNull();
    expect(id(by('moon').parent)).toBe('earth');
    expect(id(by('earth').parent)).toBe('sun');
    expect(id(by('jupiter').parent)).toBe('sun');
    // Moons of other planets, when present in the data, must belong to their planet, not to a sibling.
    const planetOf: Record<string, string> = { io: 'jupiter', europa: 'jupiter', ganymede: 'jupiter', callisto: 'jupiter', titan: 'saturn', rhea: 'saturn', triton: 'neptune', charon: 'pluto', ariel: 'uranus', oberon: 'uranus' };
    for (const [m, p] of Object.entries(planetOf)) if (BODIES.some((b) => b.id === m)) expect(id(by(m).parent)).toBe(p);
    expect(by('earth').period / 86400).toBeGreaterThan(360);
    expect(by('earth').period / 86400).toBeLessThan(370);
    expect(by('moon').period / 86400).toBeGreaterThan(26);
    expect(by('moon').period / 86400).toBeLessThan(29);
  });
});

describe('physics adapter', () => {
  // Builds real ephemeris chunks (seconds each with 26 bodies); the default 5 s is too tight under load.
  it('never builds on evaluate, installs transferred chunks in any order, and evicts', { timeout: 60_000 }, () => {
    const worker = new ReplayEphemeris();
    const main = new Ephemeris();
    const pos = new Float64Array(3 * main.count);
    expect(main.evaluate(1e6, pos, null)).toBe(false);
    worker.ensure(1e6, 1e6);
    main.install(0, worker.copy(0)!);
    expect(main.evaluate(1e6, pos, null)).toBe(true);
    const ref = new Float64Array(3 * main.count);
    worker.physics.evaluate(1e6, ref, null);
    expect(Array.from(pos)).toEqual(Array.from(ref));
    expect(main.evaluate(main.chunkSpan + 1, pos, null)).toBe(false);
    expect(main.coversRange(0, 10)).toBe(true);
    expect(main.evict([0])).toBe(1);
    expect(main.covers(1e6)).toBe(false);
  });
});
