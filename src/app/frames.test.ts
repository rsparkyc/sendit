import { describe, expect, it } from 'vitest';
import { computeFrame, ECLIPTIC_AXES, fromFrame, newFrameState, parseFrameKey, frameKey, toFrame, velocityToFrame, type BodySnapshot, type FrameSpec } from './frames';

/** Three bodies: 0 heavy at origin-ish, 1 orbiting it in a tilted plane, 2 elsewhere. */
function snapshot(): BodySnapshot {
  return {
    count: 3,
    gm: [1000, 10, 1],
    pos: [1, 2, 3, 101, 2, 3, -50, 40, 7],
    vel: [0.1, 0, 0, 0.1, 0, 5, 0, 0, 0],
  };
}

function apply(spec: FrameSpec, p: number[]) {
  const f = computeFrame(spec, snapshot(), newFrameState());
  const q = [0, 0, 0];
  toFrame(f, p, 0, q, 0);
  return { f, q };
}

describe('frames', () => {
  it('axes are orthonormal and right-handed in every frame', () => {
    for (const spec of [{ kind: 'barycentric' }, { kind: 'inertial', center: 1 }, { kind: 'rotating', center: 0, secondary: 1 }] as FrameSpec[]) {
      const a = computeFrame(spec, snapshot(), newFrameState()).axes;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const d = a[3 * i] * a[3 * j] + a[3 * i + 1] * a[3 * j + 1] + a[3 * i + 2] * a[3 * j + 2];
          expect(d).toBeCloseTo(i === j ? 1 : 0, 14);
        }
      }
      // x × y = z
      expect(a[1] * a[5] - a[2] * a[4]).toBeCloseTo(a[6], 14);
      expect(a[2] * a[3] - a[0] * a[5]).toBeCloseTo(a[7], 14);
      expect(a[0] * a[4] - a[1] * a[3]).toBeCloseTo(a[8], 14);
    }
  });

  it('barycentric origin is the GM-weighted centre', () => {
    const { f } = apply({ kind: 'barycentric' }, [0, 0, 0]);
    expect(f.origin[0]).toBeCloseTo((1000 * 1 + 10 * 101 - 50) / 1011, 12);
    expect(f.origin[1]).toBeCloseTo((1000 * 2 + 10 * 2 + 40) / 1011, 12);
  });

  it('inertial frame: body at origin, ecliptic axes (ICRF z maps to ecliptic north tilt)', () => {
    const { q } = apply({ kind: 'inertial', center: 0 }, [1, 2, 3]);
    expect(q).toEqual([0, 0, 0]);
    const { q: qz } = apply({ kind: 'inertial', center: 0 }, [1, 2, 4]);
    // Celestial pole is 23.44 deg from the ecliptic pole, toward -y_ecl.
    expect(qz[2]).toBeCloseTo(Math.cos((23.4392794 * Math.PI) / 180), 7);
    expect(qz[1]).toBeCloseTo(Math.sin((23.4392794 * Math.PI) / 180), 7);
    expect(ECLIPTIC_AXES[0]).toBe(1);
  });

  it('rotating frame puts the secondary on +x and its orbit normal on +z', () => {
    const { q } = apply({ kind: 'rotating', center: 0, secondary: 1 }, [101, 2, 3]);
    expect(q[0]).toBeCloseTo(100, 12);
    expect(q[1]).toBeCloseTo(0, 12);
    expect(q[2]).toBeCloseTo(0, 12);
    // Relative velocity of 1 is +z (ICRF), relative position +x, so h = x × z = -y: frame z is -y_ICRF.
    const { q: qn } = apply({ kind: 'rotating', center: 0, secondary: 1 }, [1, 1, 3]);
    expect(qn[2]).toBeCloseTo(1, 12);
  });

  it('fromFrame inverts toFrame', () => {
    const f = computeFrame({ kind: 'rotating', center: 0, secondary: 1 }, snapshot(), newFrameState());
    const p = [123.5, -7.25, 1e6];
    const q = [0, 0, 0];
    const back = [0, 0, 0];
    toFrame(f, p, 0, q, 0);
    fromFrame(f, q, 0, back, 0);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(p[k], 8);
  });

  it('a point co-rotating with the secondary has zero velocity in the rotating frame', () => {
    const s = snapshot();
    const f = computeFrame({ kind: 'rotating', center: 0, secondary: 1 }, s, newFrameState());
    // The secondary itself, on a circular orbit (v ⊥ r): zero velocity in the frame.
    const out = [0, 0, 0];
    velocityToFrame(f, [101, 2, 3], [0.1, 0, 5], out);
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(0, 12);
    // A point at twice the radius moving at twice the speed is also fixed.
    velocityToFrame(f, [201, 2, 3], [0.1, 0, 10], out);
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(0, 12);
  });

  it('a uniform circular orbit traces a fixed point in the rotating frame and a circle in the inertial one', () => {
    // Body 1 circles body 0 (fixed) with period 2*pi; spacecraft at 2 units, phase-locked 90 deg ahead.
    const at = (t: number): BodySnapshot => ({
      count: 2,
      gm: [1, 0],
      pos: [0, 0, 0, Math.cos(t), Math.sin(t), 0],
      vel: [0, 0, 0, -Math.sin(t), Math.cos(t), 0],
    });
    const rot = newFrameState();
    for (const t of [0, 1, 2.5, 4]) {
      computeFrame({ kind: 'rotating', center: 0, secondary: 1 }, at(t), rot);
      const q = [0, 0, 0];
      toFrame(rot, [2 * Math.cos(t + Math.PI / 2), 2 * Math.sin(t + Math.PI / 2), 0], 0, q, 0);
      expect(q[0]).toBeCloseTo(0, 12);
      expect(q[1]).toBeCloseTo(2, 12);
      expect(q[2]).toBeCloseTo(0, 12);
    }
  });

  it('frame keys round-trip by body id', () => {
    const ids = ['sun', 'earth', 'moon'];
    const idx = (id: string) => ids.indexOf(id);
    for (const spec of [{ kind: 'barycentric' }, { kind: 'inertial', center: 1 }, { kind: 'rotating', center: 1, secondary: 2 }] as FrameSpec[]) {
      const key = frameKey(spec, (i) => ids[i]);
      expect(parseFrameKey(key, idx)).toEqual(spec);
    }
    expect(frameKey({ kind: 'rotating', center: 1, secondary: 2 }, (i) => ids[i])).toBe('rot:earth:moon');
    expect(parseFrameKey('rot:earth:earth', idx)).toBeNull();
    expect(parseFrameKey('in:vulcan', idx)).toBeNull();
    expect(parseFrameKey('nonsense', idx)).toBeNull();
  });

  it('rejects a degenerate rotating frame', () => {
    const s: BodySnapshot = { count: 2, gm: [1, 1], pos: [0, 0, 0, 1, 0, 0], vel: [0, 0, 0, 1, 0, 0] };
    expect(() => computeFrame({ kind: 'rotating', center: 0, secondary: 1 }, s, newFrameState())).toThrow();
  });
});
