/**
 * The compact always-visible readout: outcome (with an icon and words, never
 * colour alone) and the single most relevant number. Pure.
 */
import { errorCount, planErrors, type Objective } from './mission-layer';
import { missionById } from './missions';
import { bodyOrientation } from './orientation';
import { BODIES, bodyIndex } from './physics';
import { osculating, planeBasis, type OrbitState } from './orbit-elements';
import { fromCentre, fromSurface } from './units';
import type { AppState } from './store';

export type Tone = 'ok' | 'fail' | 'busy' | 'info';

export interface Status {
  tone: Tone;
  icon: string;
  text: string;
  /** e.g. "Moon closest 2,345 km" or "Δv 3,167 m/s". */
  key: string;
}

/** First body an objective is about (flyby, visit, orbit, reentry...), searching sequences. */
export function targetBody(objs: readonly Objective[]): string | null {
  return targetObjective(objs)?.body ?? null;
}

/** First flyby / visit / orbit objective, searching sequences. */
export function targetObjective(objs: readonly Objective[]): { kind: string; body: string } | null {
  for (const o of objs) {
    if (o.kind === 'sequence') {
      const b = targetObjective(o.steps);
      if (b) return b;
    } else if ('body' in o && (o.kind === 'flyby' || o.kind === 'visit' || o.kind === 'orbit')) return { kind: o.kind, body: o.body };
  }
  return null;
}

/** Every body named by the objectives (targets for event relevance). */
export function objectiveBodies(objs: readonly Objective[]): string[] {
  const out = new Set<string>();
  const walk = (os: readonly Objective[]) => {
    for (const o of os) {
      if (o.kind === 'sequence') walk(o.steps);
      else if ('body' in o) out.add(o.body);
    }
  };
  walk(objs);
  return [...out];
}

const ROT = new Float64Array(9);
/** Inclination (deg) of the osculating orbit through a relative state (orbit-elements.ts), to the body's equator; NaN without a rotation model. */
function inclinationAt(body: string, t: number, rel: readonly number[]): number {
  const i = bodyIndex(body);
  if (i < 0 || !Number.isFinite(bodyOrientation(i, t, ROT))) return NaN;
  return osculating(BODIES[i].gm, rel, planeBasis([ROT[2], ROT[5], ROT[8]])).incDeg;
}

/**
 * An orbit objective that failed only because the flight ended while the orbit
 * was still being held (some but not all revolutions done, flight completed):
 * a longer flight could satisfy it.
 */
export function tooShort(r: { objective: Objective; ok: boolean; detail: string }, outcome: string): boolean {
  if (r.ok || outcome !== 'completed') return false;
  if (r.objective.kind === 'sequence') return false;
  if (r.objective.kind !== 'orbit') return false;
  const m = /at most ([\d.]+) of/.exec(r.detail);
  return !!m && Number(m[1]) > 0;
}

const km = (m: number) => `${Math.round(m / 1000).toLocaleString('en-US')} km`;

/** Osculating orbit about a body at the time cursor (orbit-ui.ts orbitAbout, angles to the body's equator), or null. */
export type OrbitNow = (body: string) => { o: Pick<OrbitState, 'rp' | 'ra' | 'incDeg' | 'bound'> } | null;

export function statusOf(s: AppState, bodyName: (id: string) => string, orbitNow?: OrbitNow): Status {
  const r = s.replay;
  const m = missionById(s.missionId);
  const errs = planErrors(s.plan);
  const current = !!r && r.plan === s.plan;
  let key = '';
  if (r) {
    const tob = m?.def ? targetObjective(m.def.objectives) : null;
    const body = tob?.body ?? null;
    const now = tob?.kind === 'orbit' && body && orbitNow ? orbitNow(body) : null;
    if (now) {
      // An orbit goal: the orbit at the time cursor, from orbit-elements.ts, exactly as the Orbit panel shows it.
      const { o } = now;
      key = `${bodyName(body!)} orbit now: Pe ${fromCentre(o.rp, body!)} · Ap ${o.bound ? fromCentre(o.ra, body!) : 'none (escape)'} · i ${o.incDeg.toFixed(2)}°`;
    } else if (tob?.kind === 'orbit' && body) {
      // No state at the cursor: the orbit reached at the end (last apsides about the body), from the same osculating maths.
      const ext = r.result.events.filter((e) => e.body === body && (e.kind === 'periapsis' || e.kind === 'apoapsis'));
      const pe = [...ext].reverse().find((e) => e.kind === 'periapsis');
      const ap = [...ext].reverse().find((e) => e.kind === 'apoapsis');
      if (pe && ap) {
        const inc = inclinationAt(body, pe.t, pe.rel);
        key = `${bodyName(body)} orbit Pe ${fromCentre(pe.distance, body)} · Ap ${fromCentre(ap.distance, body)}${Number.isFinite(inc) ? ` · i ${inc.toFixed(2)}°` : ''}`;
      } else key = `${bodyName(body)}: no closed orbit`;
    } else if (body) {
      const alts = r.result.events.filter((e) => e.body === body && (e.kind === 'periapsis' || e.kind === 'impact' || e.kind === 'atmosphere-entry')).map((e) => e.altitude);
      key = alts.length ? `Closest to ${bodyName(body)} ${fromSurface(Math.min(...alts), body)}` : `${bodyName(body)}: no approach`;
    } else key = `Δv ${Math.round(r.result.totalDeltaV).toLocaleString('en-US')} m/s${r.result.ascent ? ' total' : ''}`;
  }
  if (errorCount(errs) > 0) return { tone: 'fail', icon: '⚠', text: 'Plan has errors', key };
  if (!r || !current || s.replayStatus !== 'idle' || r.preview !== null) return { tone: 'busy', icon: '…', text: 'Replaying', key };
  const ev = r.evaluation;
  const out = r.result.outcome;
  const bad = out !== 'completed' && !(out === 'atmosphere' && ev?.success);
  if (bad) return { tone: 'fail', icon: '✗', text: out === 'impact' ? 'Impact' : out === 'atmosphere' ? 'Atmospheric entry' : out.replace(/-/g, ' '), key };
  if (m?.def && ev) {
    if (ev.success) return { tone: 'ok', icon: '✓', text: 'Mission complete', key };
    const n = ev.objectives.filter((o) => o.ok).length;
    const short = ev.objectives.some((o) => tooShort(o, out));
    return { tone: 'info', icon: '○', text: `Objectives ${n}/${ev.objectives.length}${short ? ' · flight too short' : ''}`, key };
  }
  return { tone: 'info', icon: '✓', text: 'Flight completed', key };
}
