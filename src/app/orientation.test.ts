/** Surface-fixed frames with the real rotation models. */
import { describe, expect, it } from 'vitest';
import { computeFrame, ECLIPTIC_AXES, frameKey, newFrameState, parseFrameKey, toFrame, type BodySnapshot } from './frames';
import { OrbitCamera } from './camera';
import { bodyOrientation, displayPole } from './orientation';
import { BODIES, bodyIndex } from './physics';

const E = bodyIndex('earth');
const n = BODIES.length;
/** Earth at an arbitrary (moving) heliocentric place; other bodies irrelevant. */
function snap(t: number): BodySnapshot {
  const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n);
  pos[3 * E] = 1.4e11 + 30e3 * t;
  pos[3 * E + 1] = -2e10;
  vel[3 * E] = 30e3;
  return { count: n, pos, vel, gm: new Float64Array(n).fill(1), t, orient: bodyOrientation };
}

describe('surface frame', () => {
  const t0 = 8.5e8; // 2026
  const M0 = new Float64Array(9);
  const w = bodyOrientation(E, t0, M0);

  it('holds a geostationary satellite still for several days', () => {
    expect(w).toBeCloseTo(7.2921159e-5, 10);
    const R = 42_164e3;
    const fs = newFrameState();
    const q = new Float64Array(3);
    let first: Float64Array | null = null;
    let worst = 0;
    for (let h = 0; h <= 5 * 24; h += 1.7) {
      const t = t0 + h * 3600;
      const th = w * (t - t0) + 0.3;
      const s = snap(t);
      // Circular equatorial orbit at the sidereal rate, about the pole at t0.
      const p = [0, 1, 2].map((k) => s.pos[3 * E + k] + R * (Math.cos(th) * M0[3 * k] + Math.sin(th) * M0[3 * k + 1]));
      computeFrame({ kind: 'surface', center: E }, s, fs);
      toFrame(fs, p, 0, q, 0);
      if (!first) first = q.slice();
      else worst = Math.max(worst, Math.hypot(q[0] - first[0], q[1] - first[1], q[2] - first[2]));
    }
    expect(Math.hypot(...first!)).toBeCloseTo(R, -1);
    expect(worst).toBeLessThan(500); // m over five days (pole precession and UT1 drift)
  });

  it('keeps a launch site fixed', () => {
    const site = [6.378e6 * Math.cos(0.09), 0.3e6, 6.378e6 * Math.sin(0.09)]; // body-fixed, Kourou-like latitude
    const fs = newFrameState();
    const M = new Float64Array(9), q = new Float64Array(3);
    for (const dt of [0, 3600, 86400 * 3.3]) {
      const t = t0 + dt;
      const s = snap(t);
      bodyOrientation(E, t, M);
      const p = [0, 1, 2].map((k) => s.pos[3 * E + k] + M[3 * k] * site[0] + M[3 * k + 1] * site[1] + M[3 * k + 2] * site[2]);
      computeFrame({ kind: 'surface', center: E }, s, fs);
      toFrame(fs, p, 0, q, 0);
      for (let k = 0; k < 3; k++) expect(Math.abs(q[k] - site[k])).toBeLessThan(0.01); // m, float rounding at 1 AU
    }
  });

  it('has a key, and other bodies use the IAU model', () => {
    const ids = BODIES.map((b) => b.id);
    expect(frameKey({ kind: 'surface', center: E }, (i) => ids[i])).toBe('fix:earth');
    expect(parseFrameKey('fix:mars', bodyIndex)).toEqual({ kind: 'surface', center: bodyIndex('mars') });
    expect(bodyOrientation(bodyIndex('mars'), t0, new Float64Array(9))).toBeCloseTo((350.89198226 * Math.PI) / 180 / 86400, 9);
  });
});

describe('body-centred inertial frame: north up', () => {
  const epoch = 8.5e8; // plan epoch, 2026
  const pole = (b: number, out: Float64Array) => displayPole(b, epoch, out);
  /** Screen up in ICRF: the camera's up is frame +z (OrbitCamera elevation is about frame z), mapped back through the axes. */
  function screenUp(center: number, t: number): number[] {
    const fs = computeFrame({ kind: 'inertial', center }, { ...snap(t), pole }, newFrameState());
    const a = fs.axes;
    const cam = new OrbitCamera();
    cam.update(0, [0, 0, 0], 1);
    // Default view: the camera's up projected on the view plane points to +z_frame (it never rolls).
    const d = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
    const dl = Math.hypot(...d);
    const u = [0, 0, 1].map((z, k) => z - (d[2] / dl) * (d[k] / dl));
    const ul = Math.hypot(...u);
    expect(u[2] / ul).toBeGreaterThan(0.8);
    return [a[6], a[7], a[8]];
  }

  it("Earth-centred: frame z (screen up) is Earth's north pole, fixed during playback", () => {
    const M = new Float64Array(9);
    bodyOrientation(E, epoch, M);
    for (const t of [epoch, epoch + 30 * 86400]) {
      const up = screenUp(E, t);
      expect(up[0]).toBeCloseTo(M[2], 12);
      expect(up[1]).toBeCloseTo(M[5], 12);
      expect(up[2]).toBeCloseTo(M[8], 12);
    }
    // The pole points near ICRF +z (not the ecliptic pole, 23.4 deg away).
    expect(M[8]).toBeGreaterThan(0.9999);
  });

  it('axes are orthonormal and right-handed for every body with a pole', () => {
    for (let b = 0; b < n; b++) {
      const fs = computeFrame({ kind: 'inertial', center: b }, { ...snap(epoch), pole }, newFrameState());
      const a = fs.axes;
      const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
      expect(det).toBeCloseTo(1, 12);
      for (let r = 0; r < 3; r++) expect(Math.hypot(a[3 * r], a[3 * r + 1], a[3 * r + 2])).toBeCloseTo(1, 12);
    }
  });

  it('Sun-centred and barycentric frames keep ecliptic north up', () => {
    const S = bodyIndex('sun');
    expect(displayPole(S, epoch, new Float64Array(3))).toBe(false);
    for (const spec of [{ kind: 'inertial', center: S }, { kind: 'barycentric' }] as const) {
      const fs = computeFrame(spec, { ...snap(epoch), pole }, newFrameState());
      for (let k = 0; k < 9; k++) expect(fs.axes[k]).toBeCloseTo(ECLIPTIC_AXES[k], 15);
    }
  });

  it('retrograde and extreme poles are used as given by the IAU', () => {
    const eclZ = (id: string) => {
      const p = new Float64Array(3);
      expect(displayPole(bodyIndex(id), epoch, p)).toBe(true);
      return ECLIPTIC_AXES[6] * p[0] + ECLIPTIC_AXES[7] * p[1] + ECLIPTIC_AXES[8] * p[2];
    };
    // IAU planetary "north" is the pole on the north side of the invariable plane: Venus (spins retrograde) is ecliptic-north up,
    // Uranus's pole lies almost in the ecliptic (about 8 deg north). Pluto uses the right-hand (positive) pole, about 23 deg south of the ecliptic.
    expect(eclZ('venus')).toBeGreaterThan(0.99);
    expect(eclZ('uranus')).toBeGreaterThan(0.1);
    expect(eclZ('uranus')).toBeLessThan(0.2);
    expect(eclZ('pluto')).toBeLessThan(-0.3);
  });
});
