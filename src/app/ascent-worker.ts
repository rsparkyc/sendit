/// <reference lib="webworker" />
/**
 * Ascent sweeps for the launch charts, off the main thread. Each evaluation
 * is the replay's own ascent model (mission-layer ascentFor, 5-9 ms). A job
 * is a list of points along one parameter (parking altitude or azimuth);
 * points are evaluated coarse to fine (every 8th, then every 4th, ...) and
 * posted one by one, and a newer job of the same kind replaces an older one
 * between points, so a drag never queues stale work.
 */
import { ascentFor, type Spacecraft } from './mission-layer';
import type { AscentJob, AscentPoint } from './ascent-protocol';

declare const self: DedicatedWorkerGlobalScope;
const G0 = 9.80665;

const jobs = new Map<string, { job: AscentJob; order: number[]; next: number; t0: number }>();
let scheduled = false;

function order(n: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (let step = 8; step >= 1; step = step / 2) {
    for (let i = 0; i < n; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
    if (step === 1) break;
  }
  if (!seen.has(n - 1)) out.push(n - 1);
  return out;
}

function upperDv(stages: readonly Spacecraft[], k: number, prop: number): number {
  const s = stages[k];
  let above = 0;
  for (let j = k + 1; j < stages.length; j++) above += stages[j].wetMass;
  let thrust = 0, flow = 0;
  for (const e of s.engines) { thrust += e.thrust; flow += e.thrust / (e.isp * G0); }
  const ve = flow > 0 ? thrust / flow : 0;
  return ve * Math.log((s.dryMass + prop + above) / (s.dryMass + above));
}

function point(job: AscentJob, i: number): AscentPoint {
  const x = job.xs[i];
  const az = job.kind === 'az' ? x : job.azimuthDeg;
  const alt = job.kind === 'alt' ? x : job.altitudeM;
  const t0 = performance.now();
  const a = ascentFor(job.stages, job.site, job.time, az, alt);
  const ms = performance.now() - t0;
  if (!a || !a.ok) return { type: 'point', id: job.id, kind: job.kind, i, x, ok: false, dv: NaN, prop: NaN, stage: -1, reason: a && !a.ok ? a.reason : 'no Earth data', ms };
  return { type: 'point', id: job.id, kind: job.kind, i, x, ok: true, dv: upperDv(job.stages, a.upperStage, a.upperPropellant), prop: a.upperPropellant, stage: a.upperStage, reason: '', ms };
}

function pump(): void {
  scheduled = false;
  for (const [kind, j] of jobs) {
    if (j.next >= j.order.length) {
      jobs.delete(kind);
      self.postMessage({ type: 'done', id: j.job.id, kind: j.job.kind, ms: performance.now() - j.t0, n: j.order.length });
      continue;
    }
    self.postMessage(point(j.job, j.order[j.next++]));
  }
  if (jobs.size) {
    scheduled = true;
    setTimeout(pump, 0);
  }
}

self.onmessage = (ev: MessageEvent<AscentJob>) => {
  const job = ev.data;
  jobs.set(job.kind, { job, order: order(job.xs.length), next: 0, t0: performance.now() });
  if (!scheduled) {
    scheduled = true;
    setTimeout(pump, 0);
  }
};
