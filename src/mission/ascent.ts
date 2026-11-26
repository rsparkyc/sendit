/**
 * Ascent model: what a launch costs. For a vehicle launch (plan.ts, a
 * 'launch' start with ascent: 'vehicle') the stages below the spacecraft fly
 * the ascent to the parking orbit ANALYTICALLY: nothing is flown through the
 * atmosphere in the N-body integrator. This module computes how much
 * propellant that takes and so what the stage that reaches orbit has left at
 * insertion, which is where the flight (replay.ts) begins.
 *
 * DETERMINISM. Part of replay: exactly-defined operations only (+ - * /,
 * Math.sqrt/abs/min/max/floor, comparisons), dmath (sincos) and exact-math
 * (exactLn, exactExp), with fixed iteration and step counts. Same bits in
 * every engine (test/ascent.test.ts pins them). The constants in
 * ASCENT_BODIES are model, like code: changing them changes replay results
 * and needs a PHYSICS_MODEL bump (the golden ascent test fails first).
 *
 * MODEL (planar point mass over a spherical, non-rotating-atmosphere body):
 *  - Speed v is measured from the pad (so it starts at 0 and the vehicle
 *    starts vertical); the rotation is accounted for in the target:
 *    vGoal = |vIns d - vPad| = sqrt((vIns - u)^2 + c^2), u and c the pad
 *    velocity's components along the launch direction and across the orbit
 *    plane (launchGeometry). East from the equator is cheapest; a polar or
 *    retrograde launch pays for cancelling the rotation. The centrifugal
 *    relief uses the inertial horizontal speed u + v cos(gamma).
 *  - Trajectory: vertical rise to 50 m/s, a pitch-over kick, then a
 *    gravity turn (thrust along the velocity, so no steering loss):
 *      dv/dt = aT - g sin(gamma) - aD,   v dgamma/dt = -(g - vh^2/r) cos(gamma),
 *      dh/dt = v sin(gamma),
 *    with thrust aT = (F/m)(1 - eps rho/rho0) (nozzle back-pressure loss),
 *    drag aD = rho v^2 CdA / (2 m), CdA = dragArea (liftoff mass / 1 t)^(2/3)
 *    (geometrically similar vehicles), rho = rho0 exp(-h/H), vh = u + v cos
 *    gamma the inertial horizontal speed (centrifugal relief). Where the turn
 *    would carry a low thrust-to-weight upper stage below the horizontal, it
 *    holds level flight by pitching the thrust up (sin alpha = (g - vh^2/r)
 *    / aT), paying aT (1 - cos alpha): the steering loss. The kick (50
 *    bisection steps) is solved so the vehicle reaches vGoal at the powered
 *    insertion altitude hP = min(target, poweredInsertionAltitudeM). Losses
 *    therefore follow from thrust-to-weight (burn time, how long gravity
 *    acts), from the target altitude and from the vehicle's size (drag).
 *    Fixed-step midpoint rule, `steps` per stage; the crossing of vGoal is
 *    interpolated linearly inside its step.
 *  - Lower stages burn to depletion with all their engines and separate (the
 *    dry mass drops); the stage burning when vGoal is reached is the UPPER
 *    stage. If the target is above hP the vehicle coasts on the transfer
 *    ellipse (perigee hP, apogee target) and the upper stage (then the next,
 *    if it runs dry) circularises impulsively at apogee. The spacecraft (the
 *    last stage) never flies the ascent: if the lower stages cannot reach
 *    orbit the launch is invalid.
 *  - Reported: the delta-v the stages delivered (vacuum rocket equation over
 *    each stage's real mass change, everything above it as payload): the
 *    "ascent delta-v" that the scoring quantity (replay.ts totalDeltaV)
 *    includes; its breakdown; per stage the propellant used and burnout
 *    time; the upper stage and its propellant left at insertion.
 *
 * ASSUMPTIONS AND EXPECTED ERROR. No winds, a smooth pitch program rather
 * than an optimal one, a single exponential atmosphere, one back-pressure
 * fraction and one drag scale for all vehicles, engines at full thrust
 * (no throttling, no max-Q bucket), parallel boosters given as their serial
 * equivalent (catalogue in vehicles.ts), fairing counted with the first
 * stage. Calibrated against published payloads of real vehicles
 * (test/ascent-validation.test.ts and its fixture, which states the fit):
 * expect payload errors of order +-10-20 % per vehicle in absolute terms and
 * a few percent in the trends (altitude, inclination, site), which is what
 * the model is for. The losses come out at the textbook 1.3-2 km/s.
 */
import { PI, sincos } from '../physics/dmath';
import { G0 } from '../physics/spacecraft';
import { exactExp, exactLn } from './exact-math';
import type { Stage } from './plan';

/** Per-body ascent constants (data, so the Moon or Mars can be added with their own numbers). */
export interface AscentBody {
  readonly id: string;
  /** Exponential atmosphere, or null for none (no drag, no back-pressure). */
  readonly atmosphere: { readonly rho0: number; readonly scaleHeightM: number } | null;
  /** Fraction of vacuum thrust lost at surface pressure (scaled by rho/rho0). */
  readonly backPressureLoss: number;
  /** CdA per (liftoff mass in t)^(2/3), m^2. */
  readonly dragArea: number;
  /** Highest altitude of the powered ascent; higher targets coast and circularise. m. */
  readonly poweredInsertionAltitudeM: number;
  /** Integration steps per stage. */
  readonly steps: number;
}

/**
 * Calibrated constants (test/ascent-validation.test.ts). Earth: sea-level
 * density 1.225 kg/m^3 and 7.2 km scale height (US Standard Atmosphere 1976,
 * lower atmosphere fit); back-pressure loss 12 % (published sea-level /
 * vacuum thrust: Merlin 1D 845/914 kN, RD-180 3827/4152 kN, RD-107A
 * 839/1021 kN: 8-18 %); drag area 0.25 m^2 per t^(2/3) (Falcon 9: CdA ~17
 * m^2, Cd ~2 on 10.5 m^2 including base and fins: high, it also absorbs
 * what else is not modelled); both fitted to the payloads of the fixture;
 * powered insertion at 185 km, the reference LEO of user's guides.
 * Moon: no atmosphere, low insertion (lunar ascents insert at ~15-20 km).
 */
export const ASCENT_BODIES: Readonly<Record<string, AscentBody>> = {
  earth: { id: 'earth', atmosphere: { rho0: 1.225, scaleHeightM: 7200 }, backPressureLoss: 0.12, dragArea: 0.25, poweredInsertionAltitudeM: 185e3, steps: 200 },
  moon: { id: 'moon', atmosphere: null, backPressureLoss: 0, dragArea: 0, poweredInsertionAltitudeM: 18e3, steps: 200 },
};

/** Pad velocity relative to the launch plane (launchGeometry in launch.ts gives it for a site). */
export interface AscentGeometry {
  /** Component of the pad's inertial velocity along the launch direction, m/s. */
  readonly alongTrack: number;
  /** Component across the orbit plane (must be cancelled), m/s. */
  readonly crossTrack: number;
}

export interface AscentTarget {
  /** GM of the body, m^3/s^2. */
  readonly gm: number;
  /** Radius altitudes are measured from (and liftoff altitude 0), m. */
  readonly radius: number;
  /** Circular parking-orbit altitude, m. */
  readonly altitudeM: number;
}

export interface AscentLosses {
  /** Circular (or transfer-perigee) inertial speed at powered insertion, m/s. */
  readonly orbitalSpeed: number;
  /** vGoal - orbitalSpeed: negative where the rotation helps, m/s. */
  readonly rotation: number;
  /** Integral of g sin(gamma): the climb plus the gravity loss, m/s. */
  readonly gravity: number;
  /** Energy-equivalent climb cost to the insertion altitude (part of `gravity`), m/s. */
  readonly climb: number;
  readonly drag: number;
  readonly steering: number;
  readonly backPressure: number;
  /** Impulsive circularisation at apogee (targets above the powered insertion altitude). */
  readonly circularization: number;
}

export interface AscentStageUse {
  readonly stage: number;
  readonly propellantUsed: number;
  readonly propellantLeft: number;
  /** Vacuum rocket-equation delta-v of this stage's burn (everything above as payload), m/s. */
  readonly deltaV: number;
  /** Model time of burnout (lower stages) or of insertion (upper), s after liftoff. Not tied to the plan's fixed ascent time. */
  readonly time: number;
  /** Dropped during the ascent. */
  readonly separated: boolean;
}

export type AscentResult =
  | {
      readonly ok: true;
      /** Stage active at insertion (it keeps its remaining propellant). */
      readonly upperStage: number;
      /** Propellant left in the upper stage at insertion, kg. */
      readonly upperPropellant: number;
      /** Total vehicle mass at insertion, kg. */
      readonly massAtInsertion: number;
      /** Delta-v the stages delivered during the ascent, m/s (sum of stages[].deltaV). */
      readonly deltaV: number;
      readonly losses: AscentLosses;
      readonly stages: readonly AscentStageUse[];
      /** Liftoff thrust-to-weight (vacuum thrust). */
      readonly liftoffTW: number;
      /** Pitch-over kick found, rad (from vertical, at VERTICAL_RISE_SPEED). */
      readonly kick: number;
    }
  | { readonly ok: false; readonly reason: string; readonly liftoffTW: number };

/** Vertical rise until this speed, then the pitch-over kick, m/s. */
const VERTICAL_RISE_SPEED = 50;

const stageThrust = (s: Stage): number => {
  let f = 0;
  for (const e of s.engines) f += e.thrust;
  return f;
};
const stageFlow = (s: Stage): number => {
  let q = 0;
  for (const e of s.engines) q += e.thrust / (e.isp * G0);
  return q;
};

/** Mass of stages k+1.. (all unfired), summed from the top: exact for one stage. */
export function massAbove(stages: readonly Stage[], k: number): number {
  let m = 0;
  for (let j = stages.length - 1; j > k; j--) m = m + stages[j].wetMass;
  return m;
}

interface Run {
  reached: boolean;
  h: number;
  v: number;
  stage: number;
  mass: number;
  t: number;
  lg: number; ld: number; ls: number; lp: number;
  burnout: number[];
}

/**
 * Compute the ascent of `stages` (firing order, last = spacecraft, which
 * does not fire) to a circular parking orbit. Never throws for a physical
 * impossibility: { ok: false, reason }.
 */
export function computeAscent(stages: readonly Stage[], target: AscentTarget, geom: AscentGeometry, body: AscentBody): AscentResult {
  const n = stages.length;
  const mu = target.gm;
  const R = target.radius;
  const m0 = massAbove(stages, -1);
  const g0s = mu / (R * R);
  const liftoffTW = n > 1 ? stageThrust(stages[0]) / (m0 * g0s) : 0;
  if (n < 2) return { ok: false, reason: 'a vehicle launch needs a stage below the spacecraft', liftoffTW };
  if (!(target.altitudeM > 0)) return { ok: false, reason: 'parking altitude must be positive', liftoffTW };
  const hP = target.altitudeM < body.poweredInsertionAltitudeM ? target.altitudeM : body.poweredInsertionAltitudeM;
  const rP = R + hP;
  const rT = R + target.altitudeM;
  const vIns = Math.sqrt((2 * mu * rT) / (rP * (rP + rT)));
  const circ = Math.sqrt(mu / rT) - (vIns * rP) / rT;
  const du = vIns - geom.alongTrack;
  const vGoal = Math.sqrt(du * du + geom.crossTrack * geom.crossTrack);
  const atm = body.atmosphere;
  const eps = atm ? body.backPressureLoss : 0;
  const cdA = atm && body.dragArea > 0 ? body.dragArea * exactExp((2 / 3) * exactLn(m0 / 1000)) : 0;
  const N = body.steps;
  if (!(liftoffTW * (1 - eps) > 1)) return { ok: false, reason: `liftoff thrust-to-weight ${liftoffTW.toFixed(3)} is too low to lift off`, liftoffTW };

  const run = (kick: number): Run => {
    let v = 0;
    let h = 0;
    let gam = 0.5 * PI - kick;
    let lg = 0, ld = 0, ls = 0, lp = 0;
    let t = 0;
    let mass = m0;
    const burnout: number[] = [];
    const out = new Float64Array(7); // vdot, hdot, gammadot, lg', ld', ls', lp'
    const f = (v: number, h: number, gm: number, m: number, F: number): void => {
      const vertical = v < VERTICAL_RISE_SPEED;
      const [s, c] = vertical ? [1, 0] : sincos(gm);
      const hh = h > 0 ? h : 0;
      const r = R + hh;
      const g = mu / (r * r);
      let rr = 0;
      if (atm) {
        const z = hh / atm.scaleHeightM;
        rr = z < 700 ? exactExp(-z) : 0;
      }
      const aV = F / m;
      const aT = aV * (1 - eps * rr);
      const aD = atm ? (0.5 * atm.rho0 * rr * v * v * cdA) / m : 0;
      const vh = geom.alongTrack + v * c;
      const geff = g - (vh * vh) / r;
      let ca = 1;
      let gdot = 0;
      if (!vertical) {
        if (gm <= 0 && geff > 0) {
          // Hold level flight: pitch the thrust up against the unbalanced gravity.
          let sa = (geff * c) / aT;
          if (sa > 1) sa = 1;
          ca = Math.sqrt(1 - sa * sa);
          gdot = (aT * sa - geff * c) / v;
        } else gdot = -(geff * c) / v;
      }
      out[0] = aT * ca - g * s - aD;
      out[1] = v * s;
      out[2] = gdot;
      out[3] = g * s;
      out[4] = aD;
      out[5] = aT * (1 - ca);
      out[6] = aV - aT;
    };
    for (let k = 0; k < n - 1; k++) {
      const st = stages[k];
      const F = stageThrust(st);
      const mdot = stageFlow(st);
      const prop = st.wetMass - st.dryMass;
      const T = prop / mdot;
      const dt = T / N;
      const mStart = mass;
      for (let i = 0; i < N; i++) {
        const ma = mStart - mdot * (i * dt);
        const mm = mStart - mdot * ((i + 0.5) * dt);
        f(v, h, gam, ma, F);
        const vm = v + 0.5 * dt * out[0];
        const hm = h + 0.5 * dt * out[1];
        let gmid = gam + 0.5 * dt * out[2];
        if (gmid < 0) gmid = 0;
        f(vm, hm, gmid, mm, F);
        const dv = dt * out[0];
        const vn = v + dv;
        const fr = vn >= vGoal ? (dv > 0 ? (vGoal - v) / dv : 1) : 1;
        h += fr * dt * out[1];
        gam += fr * dt * out[2];
        if (gam < 0) gam = 0;
        lg += fr * dt * out[3]; ld += fr * dt * out[4]; ls += fr * dt * out[5]; lp += fr * dt * out[6];
        if (vn >= vGoal) {
          t += (i + fr) * dt;
          return { reached: true, h, v: vGoal, stage: k, mass: mStart - mdot * ((i + fr) * dt), t, lg, ld, ls, lp, burnout };
        }
        v = vn;
        if (v < 0 || h < 0) return { reached: false, h, v, stage: k, mass: ma, t: t + i * dt, lg, ld, ls, lp, burnout };
      }
      t += T;
      burnout.push(t);
      mass = massAbove(stages, k);
    }
    return { reached: false, h, v, stage: n - 1, mass, t, lg, ld, ls, lp, burnout };
  };

  // Bisect the pitch-over kick: a larger kick turns earlier and flies lower.
  let lo = 0;
  let hi = 0.5;
  for (let it = 0; it < 50; it++) {
    const mid = 0.5 * (lo + hi);
    const r = run(mid);
    // Ended above the insertion altitude (too high, or stalled while lofted): turn more; else less.
    if (r.h > hP) lo = mid;
    else hi = mid;
  }
  const best = run(hi);
  if (!best.reached) {
    return { ok: false, reason: `the vehicle cannot reach the parking orbit: its lower stages run dry ${(vGoal - best.v).toFixed(0)} m/s short of orbital speed`, liftoffTW };
  }
  if (best.h < hP - 1000) {
    return { ok: false, reason: `the vehicle cannot climb to ${(hP / 1000).toFixed(0)} km while reaching orbital speed (reaches ${(best.h / 1000).toFixed(0)} km)`, liftoffTW };
  }

  // Circularise at apogee (impulsive) with the upper stage, then the next ones.
  let k = best.stage;
  let mass = best.mass;
  let need = circ > 0 ? circ : 0;
  const used: { m0: number; m1: number; t: number }[] = [];
  for (let j = 0; j < k; j++) used.push({ m0: j === 0 ? m0 : massAbove(stages, j - 1), m1: massAbove(stages, j) + stages[j].dryMass, t: best.burnout[j] });
  let upStart = k === 0 ? m0 : massAbove(stages, k - 1);
  while (need > 0) {
    const ve = (stageThrust(stages[k]) / stageFlow(stages[k]));
    const dry = massAbove(stages, k) + stages[k].dryMass;
    const mEnd = mass * exactExp(-need / ve);
    if (mEnd >= dry) { mass = mEnd; need = 0; break; }
    need -= ve * exactLn(mass / dry);
    used.push({ m0: upStart, m1: dry, t: best.t });
    if (k + 1 >= n - 1) return { ok: false, reason: `the vehicle cannot circularise at ${(target.altitudeM / 1000).toFixed(0)} km: ${need.toFixed(0)} m/s short`, liftoffTW };
    k++;
    mass = massAbove(stages, k - 1);
    upStart = mass;
  }
  used.push({ m0: upStart, m1: mass, t: best.t });

  const uses: AscentStageUse[] = [];
  let deltaV = 0;
  for (let j = 0; j <= k; j++) {
    const st = stages[j];
    const u = used[j];
    const ve = stageThrust(st) / stageFlow(st);
    const dvj = u.m1 < u.m0 ? ve * exactLn(u.m0 / u.m1) : 0;
    deltaV += dvj;
    const pu = u.m0 - u.m1;
    uses.push({ stage: j, propellantUsed: pu, propellantLeft: st.wetMass - st.dryMass - pu, deltaV: dvj, time: u.t, separated: j < k });
  }
  const upperPropellant = mass - massAbove(stages, k) - stages[k].dryMass;
  const climb = Math.sqrt(vIns * vIns + 2 * mu * (1 / R - 1 / rP)) - vIns;
  return {
    ok: true,
    upperStage: k,
    upperPropellant,
    massAtInsertion: mass,
    deltaV,
    losses: { orbitalSpeed: vIns, rotation: vGoal - vIns, gravity: best.lg, climb, drag: best.ld, steering: best.ls, backPressure: best.lp, circularization: circ > 0 ? circ : 0 },
    stages: uses,
    liftoffTW,
    kick: hi,
  };
}
