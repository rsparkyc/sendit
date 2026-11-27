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
import { PI, atan2, sincos } from '../physics/dmath';
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

/** True unless an engine of the stage is non-throttleable (a solid: burns to depletion once lit). */
export function canShutDown(s: Stage): boolean {
  for (const e of s.engines) if (e.throttleable === false) return false;
  return true;
}
/** True unless an engine of the stage is non-restartable (cannot be relit once shut down). */
export function canRestart(s: Stage): boolean {
  for (const e of s.engines) if (e.restartable === false) return false;
  return true;
}

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
  // Propulsion flags (plan.ts Engine): only vehicles that set them reach these
  // checks' refusals, so every flag-free vehicle computes exactly as before.
  if (best.reached && !canShutDown(stages[best.stage])) {
    return { ok: false, reason: `stage ${best.stage} cannot shut down at orbital speed (a non-throttleable engine burns to depletion once lit): a parking orbit needs a stage that can stop; use direct injection`, liftoffTW };
  }
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
  if (need > 0 && !canRestart(stages[k])) {
    return { ok: false, reason: `stage ${k} cannot restart to circularise at ${(target.altitudeM / 1000).toFixed(0)} km (a non-restartable engine): choose a parking orbit at or below ${(body.poweredInsertionAltitudeM / 1000).toFixed(0)} km`, liftoffTW };
  }
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

// ---------------------------------------------------------------------------
// Direct injection
// ---------------------------------------------------------------------------

/**
 * DIRECT INJECTION (plan start 'launch' with ascent: 'direct'). No parking
 * orbit: the stages burn in order from liftoff straight into the departure
 * conic. Same vehicle model, integrator, atmosphere and pitch program as the
 * parking ascent above (vertical rise, kick, gravity turn, level hold below
 * circular speed), with three differences:
 *  - The goal is an orbital ENERGY, not a speed at an altitude. The player
 *    gives the target C3 = v^2 - 2 mu / r (m^2/s^2; negative: an ellipse,
 *    about -2 km^2/s^2 for an apogee at lunar distance; positive: a
 *    hyperbola with v_inf = sqrt(C3)) and the INJECTION ALTITUDE hI at which
 *    powered flight ends. The model solves for the pitch-over kick (50
 *    bisection steps, as above) so that powered flight ends at hI.
 *  - Powered flight ends when the energy reaches the target AND the burning
 *    stage can shut down (no engine with throttleable: false). A stage that
 *    cannot (a solid) burns to depletion once lit: the energy overshoots,
 *    achievedC3 > c3, and no later stage is lit. If every lower stage burns
 *    out first, the flight starts from what was reached: achievedC3 < c3 and
 *    `shortfall` says by how much. Either way the result is a state, not a
 *    refusal; refused is only what cannot fly (no lift-off, falling back, or
 *    an injection altitude the pitch program cannot reach within 1 km).
 *  - Above circular speed the gravity turn lifts the nose (v dgamma/dt =
 *    -(g - vh^2/r) cos gamma > 0), so the vehicle injects climbing: the
 *    flight-path angle at burnout is reported, and burnout is in general NOT
 *    the perigee of the departure conic.
 * The burnout state is inertial: in-plane pad-relative speed vp = sqrt(v^2 -
 * c^2) (the cross-track pad velocity c is cancelled first, as vGoal above
 * assumes), horizontal speed u + vp cos(gamma), radial speed vp sin(gamma).
 * The downrange angle is integrated, dtheta/dt = (u + v cos gamma) / r, and
 * the time is the burnout time: both follow from the ascent (the parking
 * orbit's fixed 540 s and 13.5 deg do not apply). launch.ts
 * directInjectionState maps the burnout into ICRF through the same
 * Earth-orientation model and launch plane as the parking orbit.
 *
 * ASSUMPTIONS AND EXPECTED ERROR (beyond the parking model's): staging is
 * instantaneous, with no coast between stages (fixed coasts are not
 * modelled); the pitch program is the same one-parameter gravity turn, so an
 * optimised real direct ascent does better (expect the losses to be high by
 * of order 100-300 m/s for high-energy injections, which climb while they
 * burn); the cross-track cancellation and the non-rotating launch plane are
 * the parking model's approximations. The burnout direction (downrange
 * angle, flight-path angle) is the model's, of order a degree from a real
 * trajectory; the planning helpers (direct-planning.ts) use this same model,
 * so what they find is what replay flies.
 */
export interface DirectTarget {
  readonly gm: number;
  readonly radius: number;
  /** Target C3 = v^2 - 2 mu / r at burnout, m^2/s^2. */
  readonly c3: number;
  /** Altitude at which powered flight ends, m. */
  readonly injectionAltitudeM: number;
}

export interface DirectBurnout {
  /** Seconds after liftoff. */
  readonly time: number;
  /** Altitude above the body radius, m. */
  readonly altitudeM: number;
  /** Inertial speed, m/s. */
  readonly speed: number;
  /** Inertial horizontal (in the launch plane) and radial speed, m/s. */
  readonly horizontalSpeed: number;
  readonly radialSpeed: number;
  /** Inertial flight-path angle above the local horizontal, rad. */
  readonly flightPathAngle: number;
  /** Angle travelled from the liftoff site direction in the inertial launch plane, rad. */
  readonly downrange: number;
  /** C3 = v^2 - 2 mu / r, m^2/s^2. */
  readonly c3: number;
}

export interface DirectLosses {
  /** Inertial speed at burnout, m/s. */
  readonly injectionSpeed: number;
  /** Pad-relative speed gained minus injectionSpeed: negative where the rotation helps. */
  readonly rotation: number;
  readonly gravity: number;
  /** Energy-equivalent climb cost to the burnout altitude (part of `gravity`). */
  readonly climb: number;
  readonly drag: number;
  readonly steering: number;
  readonly backPressure: number;
}

export interface DirectAscentOk {
  readonly ok: true;
  readonly kind: 'direct';
  /** Stage burning (or burned out) at injection; it stays attached. */
  readonly upperStage: number;
  readonly upperPropellant: number;
  readonly massAtInsertion: number;
  /** Delta-v the stages delivered, m/s (sum of stages[].deltaV). */
  readonly deltaV: number;
  readonly losses: DirectLosses;
  readonly stages: readonly AscentStageUse[];
  readonly liftoffTW: number;
  readonly kick: number;
  readonly burnout: DirectBurnout;
  readonly targetC3: number;
  readonly achievedC3: number;
  /** max(0, targetC3 - achievedC3): the vehicle ran dry short of the target. */
  readonly shortfall: number;
  /** 'target': shut down at the target energy; 'depletion': the last lit stage burned out (solid overshoot, or shortfall). */
  readonly cutoff: 'target' | 'depletion';
}

export type DirectAscentResult = DirectAscentOk | { readonly ok: false; readonly reason: string; readonly liftoffTW: number };

interface DirectRun {
  crashed: boolean;
  reachedTarget: boolean;
  h: number;
  v: number;
  gam: number;
  th: number;
  stage: number;
  mass: number;
  t: number;
  lg: number; ld: number; ls: number; lp: number;
  burnout: number[];
}

/** Bisection range of the direct ascent's pitch-over kick, rad (wider than the parking ascent's: high-energy ascents must turn hard to stay low). */
const DIRECT_KICK_MAX = 1.2;
/** How close to the requested injection altitude powered flight must end, m. */
export const DIRECT_ALTITUDE_TOLERANCE_M = 5000;

/**
 * Ascent of `stages` (firing order, last = spacecraft, never fired) by
 * direct injection to `target` (see the section comment). Deterministic:
 * the same operations and fixed iteration counts as computeAscent.
 */
export function computeDirectAscent(stages: readonly Stage[], target: DirectTarget, geom: AscentGeometry, body: AscentBody): DirectAscentResult {
  const n = stages.length;
  const mu = target.gm;
  const R = target.radius;
  const m0 = massAbove(stages, -1);
  const g0s = mu / (R * R);
  const liftoffTW = n > 1 ? stageThrust(stages[0]) / (m0 * g0s) : 0;
  if (n < 2) return { ok: false, reason: 'a vehicle launch needs a stage below the spacecraft', liftoffTW };
  const hI = target.injectionAltitudeM;
  if (!(hI > 0)) return { ok: false, reason: 'injection altitude must be positive', liftoffTW };
  const eGoal = 0.5 * target.c3;
  const u = geom.alongTrack;
  const c2 = geom.crossTrack * geom.crossTrack;
  const atm = body.atmosphere;
  const eps = atm ? body.backPressureLoss : 0;
  const cdA = atm && body.dragArea > 0 ? body.dragArea * exactExp((2 / 3) * exactLn(m0 / 1000)) : 0;
  const N = body.steps;
  if (!(liftoffTW * (1 - eps) > 1)) return { ok: false, reason: `liftoff thrust-to-weight ${liftoffTW.toFixed(3)} is too low to lift off`, liftoffTW };

  /** Inertial in-plane [horizontal, radial] speed for pad-relative speed v at flight-path angle gm. */
  const inertial = (v: number, gm: number): [number, number] => {
    const vp2 = v * v - c2;
    const vp = vp2 > 0 ? Math.sqrt(vp2) : 0;
    const [s, c] = v < VERTICAL_RISE_SPEED ? [1, 0] : sincos(gm);
    return [u + vp * c, vp * s];
  };
  const energy = (v: number, h: number, gm: number): number => {
    const [x, y] = inertial(v, gm);
    return 0.5 * (x * x + y * y) - mu / (R + (h > 0 ? h : 0));
  };

  const run = (kick: number): DirectRun => {
    let v = 0;
    let h = 0;
    let gam = 0.5 * PI - kick;
    let th = 0;
    let lg = 0, ld = 0, ls = 0, lp = 0;
    let t = 0;
    let mass = m0;
    let reachedTarget = false;
    const burnout: number[] = [];
    const out = new Float64Array(8); // vdot, hdot, gammadot, lg', ld', ls', lp', thetadot
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
      const vh = u + v * c;
      const geff = g - (vh * vh) / r;
      let ca = 1;
      let gdot = 0;
      if (!vertical) {
        if (gm <= 0 && geff > 0) {
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
      out[7] = vh / r;
    };
    for (let k = 0; k < n - 1; k++) {
      const st = stages[k];
      const F = stageThrust(st);
      const mdot = stageFlow(st);
      const prop = st.wetMass - st.dryMass;
      const T = prop / mdot;
      const dt = T / N;
      const mStart = mass;
      const stoppable = canShutDown(st);
      let e0 = energy(v, h, gam);
      for (let i = 0; i < N; i++) {
        const ma = mStart - mdot * (i * dt);
        const mm = mStart - mdot * ((i + 0.5) * dt);
        f(v, h, gam, ma, F);
        const vm = v + 0.5 * dt * out[0];
        const hm = h + 0.5 * dt * out[1];
        let gmid = gam + 0.5 * dt * out[2];
        if (gmid < 0) gmid = 0;
        f(vm, hm, gmid, mm, F);
        const vn = v + dt * out[0];
        const hn = h + dt * out[1];
        let gn = gam + dt * out[2];
        if (gn < 0) gn = 0;
        const e1 = energy(vn, hn, gn);
        const cross = !reachedTarget && e1 >= eGoal;
        if (cross) reachedTarget = true;
        const fr = cross && stoppable ? (e1 > e0 ? (eGoal - e0) / (e1 - e0) : 1) : 1;
        v += fr * dt * out[0];
        h += fr * dt * out[1];
        gam += fr * dt * out[2];
        if (gam < 0) gam = 0;
        th += fr * dt * out[7];
        lg += fr * dt * out[3]; ld += fr * dt * out[4]; ls += fr * dt * out[5]; lp += fr * dt * out[6];
        if (cross && stoppable) {
          t += (i + fr) * dt;
          return { crashed: false, reachedTarget, h, v, gam, th, stage: k, mass: mStart - mdot * ((i + fr) * dt), t, lg, ld, ls, lp, burnout };
        }
        if (v < 0 || h < 0) return { crashed: true, reachedTarget, h, v, gam, th, stage: k, mass: ma, t: t + i * dt, lg, ld, ls, lp, burnout };
        e0 = e1;
      }
      t += T;
      if (reachedTarget || k === n - 2) {
        // A solid that passed the target, or the last lower stage: burned out, stays attached.
        return { crashed: false, reachedTarget, h, v, gam, th, stage: k, mass: massAbove(stages, k) + st.dryMass, t, lg, ld, ls, lp, burnout };
      }
      burnout.push(t);
      mass = massAbove(stages, k);
    }
    return { crashed: true, reachedTarget, h, v, gam, th, stage: n - 1, mass, t, lg, ld, ls, lp, burnout };
  };

  // Bisect the kick: a larger kick turns earlier and ends lower (falling back counts as too low).
  let lo = 0;
  let hi = DIRECT_KICK_MAX;
  for (let it = 0; it < 50; it++) {
    const mid = 0.5 * (lo + hi);
    const r = run(mid);
    if (!r.crashed && r.h > hI) lo = mid;
    else hi = mid;
  }
  let kick = hi;
  let best = run(kick);
  if (best.crashed) { kick = lo; best = run(kick); }
  if (best.crashed) return { ok: false, reason: `the vehicle cannot fly a direct ascent to ${(hI / 1000).toFixed(0)} km: it falls back before burnout`, liftoffTW };
  // The end altitude is not quite continuous in the kick (staging of low
  // thrust-to-weight upper stages), so the bisection may stop a little short:
  // accept 5 km (burnout.altitudeM reports what was reached).
  if (best.h < hI - DIRECT_ALTITUDE_TOLERANCE_M || best.h > hI + DIRECT_ALTITUDE_TOLERANCE_M) {
    return { ok: false, reason: `the vehicle cannot end its powered flight at ${(hI / 1000).toFixed(0)} km (it ends at ${(best.h / 1000).toFixed(0)} km)`, liftoffTW };
  }
  const k = best.stage;
  const uses: AscentStageUse[] = [];
  let deltaV = 0;
  for (let j = 0; j <= k; j++) {
    const st = stages[j];
    const mA = j === 0 ? m0 : massAbove(stages, j - 1);
    const mB = j < k ? massAbove(stages, j) + st.dryMass : best.mass;
    const ve = stageThrust(st) / stageFlow(st);
    const dvj = mB < mA ? ve * exactLn(mA / mB) : 0;
    deltaV += dvj;
    const pu = mA - mB;
    uses.push({ stage: j, propellantUsed: pu, propellantLeft: st.wetMass - st.dryMass - pu, deltaV: dvj, time: j < k ? best.burnout[j] : best.t, separated: j < k });
  }
  const upperPropellant = best.mass - massAbove(stages, k) - stages[k].dryMass;
  const [hs, rs] = inertial(best.v, best.gam);
  const r = R + best.h;
  const speed = Math.sqrt(hs * hs + rs * rs);
  const achievedC3 = speed * speed - (2 * mu) / r;
  const climb = Math.sqrt(speed * speed + 2 * mu * (1 / R - 1 / r)) - speed;
  const cutAtTarget = best.reachedTarget && canShutDown(stages[k]) && upperPropellant > 0;
  return {
    ok: true,
    kind: 'direct',
    upperStage: k,
    upperPropellant,
    massAtInsertion: best.mass,
    deltaV,
    losses: { injectionSpeed: speed, rotation: best.v - speed, gravity: best.lg, climb, drag: best.ld, steering: best.ls, backPressure: best.lp },
    stages: uses,
    liftoffTW,
    kick,
    burnout: { time: best.t, altitudeM: best.h, speed, horizontalSpeed: hs, radialSpeed: rs, flightPathAngle: atan2(rs, hs), downrange: best.th, c3: achievedC3 },
    targetC3: target.c3,
    achievedC3,
    // Cut off at the target, the energy is the target's to the step's linear interpolation (~1e-4 km^2/s^2): no shortfall.
    shortfall: !cutAtTarget && target.c3 > achievedC3 ? target.c3 - achievedC3 : 0,
    cutoff: cutAtTarget ? 'target' : 'depletion',
  };
}
