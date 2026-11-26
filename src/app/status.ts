/**
 * The compact always-visible readout: outcome (with an icon and words, never
 * colour alone) and the single most relevant number. Pure.
 */
import { planErrors, type Objective } from './mission-layer';
import { missionById } from './missions';
import { bodyOrientation } from './orientation';
import { bodyIndex } from './physics';
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
/** Inclination (deg) of the orbit through a relative state, to the body's equator; NaN without a rotation model. */
function inclinationAt(body: string, t: number, rel: readonly number[]): number {
  const i = bodyIndex(body);
  if (i < 0 || !Number.isFinite(bodyOrientation(i, t, ROT))) return NaN;
  const hx = rel[1] * rel[5] - rel[2] * rel[4], hy = rel[2] * rel[3] - rel[0] * rel[5], hz = rel[0] * rel[4] - rel[1] * rel[3];
  const c = (hx * ROT[2] + hy * ROT[5] + hz * ROT[8]) / Math.hypot(hx, hy, hz);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
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

export function statusOf(s: AppState, bodyName: (id: string) => string): Status {
  const r = s.replay;
  const m = missionById(s.missionId);
  const errs = planErrors(s.plan);
  const current = !!r && r.plan === s.plan;
  let key = '';
  if (r) {
    const tob = m?.def ? targetObjective(m.def.objectives) : null;
    const body = tob?.body ?? null;
    if (tob?.kind === 'orbit' && body) {
      // An orbit goal: the orbit reached at the end (last apsides about the body) and its inclination.
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
    } else key = `Δv ${Math.round(r.result.deltaV).toLocaleString('en-US')} m/s`;
  }
  if (errs.plan.length + errs.burns.size > 0) return { tone: 'fail', icon: '⚠', text: 'Plan has errors', key };
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
