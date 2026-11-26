import { describe, expect, it } from 'vitest';
import { FixedBodies, G0, propagate, type Burn } from '../src/physics/spacecraft';
import { Dop853 } from '../src/physics/dop853';

const GM_EARTH = 3.986004418e14;
const earth = new FixedBodies([{ gm: GM_EARTH, position: [0, 0, 0] }]);
const empty = new FixedBodies([]);

const R = 6_678_000;
const V_CIRC = Math.sqrt(GM_EARTH / R);
const circular = [R, 0, 0, 0, V_CIRC, 0, 2000];

const energy = (y: ArrayLike<number>) =>
  0.5 * (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) - GM_EARTH / Math.hypot(y[0], y[1], y[2]);

describe('finite burns', () => {
  it('matches the rocket equation in free space', () => {
    const m0 = 2000;
    const burn: Burn = {
      tStart: 100,
      duration: 300,
      thrust: 5000,
      isp: 320,
      direction: [3, 0, 4], // deliberately not unit length
      frame: { kind: 'inertial' },
    };
    const mdot = burn.thrust / (burn.isp * G0);
    const m1 = m0 - mdot * burn.duration;
    const dv = burn.isp * G0 * Math.log(m0 / m1);
    // Distance covered during the burn, then coasting at dv for the remaining 600 s.
    const ve = burn.isp * G0;
    const burnDist = ve * burn.duration - (ve * m1 * Math.log(m0 / m1)) / mdot;
    const dist = burnDist + dv * 600;

    const out = propagate(empty, [0, 0, 0, 0, 0, 0, m0], 0, 1000, [burn]);
    const speed = Math.hypot(out.y[3], out.y[4], out.y[5]);
    console.log(`rocket eq: dv ${speed} vs ${dv} m/s, mass ${out.y[6]} vs ${m1} kg`);

    expect(Math.abs(speed / dv - 1)).toBeLessThan(1e-11);
    expect(Math.abs(out.y[6] / m1 - 1)).toBeLessThan(1e-12);
    expect(out.y[3] / speed).toBeCloseTo(0.6, 12);
    expect(out.y[5] / speed).toBeCloseTo(0.8, 12);
    expect(out.y[4]).toBe(0);
    expect(Math.abs(Math.hypot(out.y[0], out.y[1], out.y[2]) / dist - 1)).toBeLessThan(1e-11);
  });

  it('cuts off when the tanks run dry', () => {
    const m0 = 2000;
    const dryMass = 1500;
    const burn: Burn = {
      tStart: 0,
      duration: 10_000, // far more than the propellant allows
      thrust: 5000,
      isp: 320,
      direction: [1, 0, 0],
      frame: { kind: 'inertial' },
    };
    const out = propagate(empty, [0, 0, 0, 0, 0, 0, m0], 0, 20_000, [burn], { dryMass });
    const dv = burn.isp * G0 * Math.log(m0 / dryMass);
    expect(Math.abs(out.y[6] - dryMass)).toBeLessThan(1e-8);
    expect(Math.abs(out.y[3] / dv - 1)).toBeLessThan(1e-11);
  });

  it('normal and radial burns do no work; prograde burns do', () => {
    const base = { tStart: 200, duration: 400, thrust: 2000, isp: 300 };
    const frame = { kind: 'orbital', body: 0 } as const;
    const run = (direction: [number, number, number]) =>
      propagate(earth, circular, 0, 3000, [{ ...base, direction, frame }]);

    const e0 = energy(circular);
    const prograde = run([1, 0, 0]);
    const retro = run([-1, 0, 0]);
    const normal = run([0, 1, 0]);
    const radial = run([0, 0, 1]);

    // Thrust perpendicular to velocity cannot change orbital energy.
    expect(Math.abs(energy(normal.y) / e0 - 1)).toBeLessThan(1e-10);
    expect(Math.abs(energy(radial.y) / e0 - 1)).toBeLessThan(1e-10);
    expect(energy(prograde.y)).toBeGreaterThan(e0 * 0.99);
    expect(energy(retro.y)).toBeLessThan(e0 * 1.01);

    // Normal burn tilts the plane toward +z (angular momentum direction); radial keeps it.
    const hx = (y: Float64Array) => y[1] * y[5] - y[2] * y[4];
    const hz = (y: Float64Array) => y[0] * y[4] - y[1] * y[3];
    const inclination = (y: Float64Array) => Math.abs(Math.atan2(Math.hypot(hx(y), y[2] * y[3] - y[0] * y[5]), hz(y)));
    expect(inclination(normal.y)).toBeGreaterThan(0.01);
    expect(inclination(radial.y)).toBeLessThan(1e-12);
    expect(inclination(prograde.y)).toBeLessThan(1e-12);

    // Radial-out is +x at the start of this orbit: a radial burn at t=0 must push outward.
    const kick = propagate(earth, circular, 0, 50, [{ ...base, tStart: 0, duration: 50, direction: [0, 0, 1], frame }]);
    const coast = propagate(earth, circular, 0, 50);
    expect(Math.hypot(kick.y[0], kick.y[1])).toBeGreaterThan(Math.hypot(coast.y[0], coast.y[1]) + 1);
  });

  it('short prograde burn approximates the impulsive delta-v', () => {
    const burn: Burn = {
      tStart: 0,
      duration: 20,
      thrust: 10_000,
      isp: 300,
      direction: [1, 0, 0],
      frame: { kind: 'orbital', body: 0 },
    };
    const mdot = burn.thrust / (burn.isp * G0);
    const dv = burn.isp * G0 * Math.log(2000 / (2000 - mdot * burn.duration));
    const out = propagate(earth, circular, 0, 20, [burn]);
    const impulsive = 0.5 * (V_CIRC + dv) ** 2 - GM_EARTH / R;
    // Gravity loss over a 20 s burn is tiny, so energies agree to ~1e-5 but not exactly.
    expect(Math.abs(energy(out.y) / impulsive - 1)).toBeLessThan(1e-4);
    expect(energy(out.y)).toBeLessThan(impulsive);
  });

  it('gives the same answer whether or not the propagation is split mid-burn', () => {
    const burn: Burn = {
      tStart: 500,
      duration: 600,
      thrust: 3000,
      isp: 310,
      direction: [1, 0.2, -0.1],
      frame: { kind: 'orbital', body: 0 },
    };
    const whole = propagate(earth, circular, 0, 5000, [burn]);
    const first = propagate(earth, circular, 0, 800, [burn]);
    const second = propagate(earth, first.y, 800, 5000, [burn]);
    expect(Math.hypot(whole.y[0] - second.y[0], whole.y[1] - second.y[1], whole.y[2] - second.y[2])).toBeLessThan(1e-3);
    expect(Math.abs(whole.y[6] - second.y[6])).toBeLessThan(1e-9);
  });

  it('rejects overlapping burns', () => {
    const b = { duration: 100, thrust: 1, isp: 300, direction: [1, 0, 0] as [number, number, number], frame: { kind: 'inertial' } as const };
    expect(() => propagate(empty, circular, 0, 10, [{ ...b, tStart: 0 }, { ...b, tStart: 50 }])).toThrow(/overlap/);
  });

  it('lands exactly on dryMass when the tanks run dry, with no follow-on segment', () => {
    // Awkward numbers so propellant / mdot is not exact and integrated mass leaves residue.
    const base = { thrust: 4321.123, isp: 311.7, direction: [1, 0.3, 0] as [number, number, number] };
    for (const frame of [{ kind: 'inertial' } as const, { kind: 'orbital', body: 0 } as const]) {
      const burns: Burn[] = [
        { ...base, frame, tStart: 37.3, duration: 10_000 }, // empties the tanks
        { ...base, frame, tStart: 10_037.3, duration: 50 }, // nothing left for this one
      ];
      const steps: number[] = [];
      const out = propagate(earth, circular, 0, 11_000, burns, {
        dryMass: 1234.567,
        onStep: (t) => steps.push(t),
      });
      expect(out.y[6]).toBe(1234.567);
      // No microscopic segments anywhere.
      for (let k = 1; k < steps.length; k++) expect(steps[k] - steps[k - 1]).toBeGreaterThan(1e-3);
    }
    // Back-to-back burns, the first empties the tanks exactly at its own end time.
    const mdot = base.thrust / (base.isp * G0);
    const dur = 500 / mdot;
    const out = propagate(empty, [0, 0, 0, 0, 0, 0, 2000], 0, 2 * dur + 100, [
      { ...base, frame: { kind: 'inertial' }, tStart: 0, duration: dur * (1 + 1e-15) },
      { ...base, frame: { kind: 'inertial' }, tStart: dur * (1 + 1e-15), duration: dur },
    ], { dryMass: 1500 });
    expect(out.y[6]).toBe(1500);
  });

  it('throws a clear error for a degenerate orbital frame', () => {
    const frame = { kind: 'orbital', body: 0 } as const;
    const b = { tStart: 0, duration: 10, thrust: 100, isp: 300, direction: [1, 0, 0] as [number, number, number], frame };
    // Zero velocity relative to the body.
    expect(() => propagate(earth, [R, 0, 0, 0, 0, 0, 1000], 0, 10, [b])).toThrow(/burn 0: .*zero velocity/);
    // Radial velocity: r x v = 0.
    expect(() => propagate(earth, [R, 0, 0, 100, 0, 0, 1000], 0, 10, [b])).toThrow(/burn 0: .*parallel/);
    const two = [{ ...b, frame: { kind: 'inertial' } as const }, { ...b, tStart: 20 }];
    expect(() => propagate(earth, [R, 0, 0, 100, 0, 0, 1000], 0, 30, two)).toThrow(/burn 1: .*parallel/);
  });

  describe('dense output through onStep', () => {
    const GM = GM_EARTH;
    // Independent reference: our own integrator at rtol 1e-14 with a hand-written RHS.
    function reference(t: number, burn: Burn | null): Float64Array {
      let on = false;
      const f = (_t: number, y: Float64Array, o: Float64Array) => {
        const r2 = y[0] * y[0] + y[1] * y[1] + y[2] * y[2];
        const k = -GM / (r2 * Math.sqrt(r2));
        o[0] = y[3]; o[1] = y[4]; o[2] = y[5];
        o[3] = k * y[0]; o[4] = k * y[1]; o[5] = k * y[2]; o[6] = 0;
        if (on && burn) {
          const v = Math.hypot(y[3], y[4], y[5]);
          const a = burn.thrust / y[6];
          o[3] += (a * y[3]) / v; o[4] += (a * y[4]) / v; o[5] += (a * y[5]) / v;
          o[6] = -burn.thrust / (burn.isp * G0);
        }
      };
      const s = (y: Float64Array, yn: Float64Array, sc: Float64Array) => {
        for (let j = 0; j < 7; j++) sc[j] = 1e-9 + 1e-14 * Math.max(Math.abs(y[j]), Math.abs(yn[j]), j < 3 ? R : 7000);
      };
      const integ = new Dop853(7, f, s);
      integ.reset(0, circular);
      if (burn && t > burn.tStart) {
        integ.integrateTo(burn.tStart);
        on = true;
        integ.refresh();
      }
      integ.integrateTo(t);
      return Float64Array.from(integ.y);
    }

    it('interpolates with the right-hand side of the step it belongs to', () => {
      const burn: Burn = { tStart: 1000, duration: 300, thrust: 3000, isp: 300, direction: [1, 0, 0], frame: { kind: 'orbital', body: 0 } };
      const out = new Float64Array(7);
      const checks: { label: string; err: number; t: number }[] = [];
      let lastBefore: [number, number] | null = null;
      let firstAfter = false;
      let held: ((t: number, o: Float64Array) => void) | null = null;
      propagate(earth, circular, 0, 2000, [burn], {
        onStep: (t, _y, interpolate, tPrev) => {
          held = interpolate;
          const check = (label: string) => {
            const tm = tPrev + 0.37 * (t - tPrev);
            interpolate(tm, out);
            const ref = reference(tm, burn);
            checks.push({ label, t: tm, err: Math.hypot(out[0] - ref[0], out[1] - ref[1], out[2] - ref[2]) + 1e3 * Math.abs(out[6] - ref[6]) });
          };
          if (t === burn.tStart) { lastBefore = [tPrev, t]; check('last coast step before ignition'); }
          else if (tPrev === burn.tStart) { firstAfter = true; check('first burn step'); }
          else if (tPrev > burn.tStart && t <= burn.tStart + burn.duration) check('burn step');
        },
      });
      expect(lastBefore).not.toBeNull();
      expect(firstAfter).toBe(true);
      for (const c of checks) {
        // Burn displacement at these offsets is metres to km; interpolation error must be mm-level.
        expect(c.err, `${c.label} at t=${c.t}`).toBeLessThan(1e-3);
      }
      expect(checks.filter((c) => c.label === 'burn step').length).toBeGreaterThan(0);
      expect(() => held!(1500, out)).toThrow(/only valid during onStep/);
    });
  });
});
