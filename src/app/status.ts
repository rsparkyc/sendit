/**
 * The compact always-visible readout: outcome (with an icon and words, never
 * colour alone) and the single most relevant number. Pure.
 */
import { planErrors, type Objective } from './mission-layer';
import { missionById } from './missions';
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
  for (const o of objs) {
    if (o.kind === 'sequence') {
      const b = targetBody(o.steps);
      if (b) return b;
    } else if ('body' in o && (o.kind === 'flyby' || o.kind === 'visit' || o.kind === 'orbit')) return o.body;
  }
  return null;
}

const km = (m: number) => `${Math.round(m / 1000).toLocaleString('en-US')} km`;

export function statusOf(s: AppState, bodyName: (id: string) => string): Status {
  const r = s.replay;
  const m = missionById(s.missionId);
  const errs = planErrors(s.plan);
  const current = !!r && r.plan === s.plan;
  let key = '';
  if (r) {
    const body = m?.def ? targetBody(m.def.objectives) : null;
    if (body) {
      const alts = r.result.events.filter((e) => e.body === body && (e.kind === 'periapsis' || e.kind === 'impact' || e.kind === 'atmosphere-entry')).map((e) => e.altitude);
      key = alts.length ? `${bodyName(body)} closest ${km(Math.min(...alts))}` : `${bodyName(body)}: no approach`;
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
    return { tone: 'info', icon: '○', text: `Objectives ${n}/${ev.objectives.length}`, key };
  }
  return { tone: 'info', icon: '✓', text: 'Flight completed', key };
}
