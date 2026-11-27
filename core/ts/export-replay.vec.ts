/**
 * Replay vectors (core/fixtures/generated/replay.txt) for core/src/mission/{events,replay}.rs.
 *
 * Corpus: every campaign reference plan (mission x offered site), the pinned
 * model-2 and staged fixtures, and perturbed variants of the Earth-Moon
 * references (burns shifted, the first burn cut short, a retrograde first
 * burn that ends in the atmosphere or at the surface, separations moved,
 * no events but impacts with stopOnAtmosphere false and a watched-body list,
 * tiny step and event budgets, a degenerate orbital-frame burn, a version
 * mismatch). For each: the plan (its canonical encoding), the replay options,
 * and the whole result: outcome, reason, digest, every event (kind, body,
 * time, distance, altitude, speed, relative state, mass, sphere), burn and
 * stage reports, launch insertion, ascent totals, final state, step count,
 * and a sample of dense-output states seen by onStep.
 * World: the real ephemeris with the shipped checkpoint asset (test/helpers/real-world.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { Lines } from './shared';
import { encodePlan, type MissionPlan } from '../../src/mission/plan';
import { replay, type ReplayOptions } from '../../src/mission/replay';
import { realWorld } from '../../test/helpers/real-world';
import { replayCorpus, replayRecord } from './replay-corpus';

const OUT = new URL('../fixtures/generated/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex') || '-';

it('export replay vectors', () => {
  const W = new Lines();
  const { world } = realWorld();
  const fp = world.fingerprint;
  const run = (name: string, plan: MissionPlan, opts: ReplayOptions) => {
    const rec = replayRecord({ name, plan, opts }, encodePlan);
    if (!rec) return;
    W.add(...rec);
    const samples: number[][] = [];
    let k = 0;
    const out = new Float64Array(7);
    const r = replay(plan, world, {
      ...opts,
      onStart: (t, y) => samples.push([-1, t, ...Array.from(y)]),
      onStep: (t, tPrev, interp) => {
        if (k++ % 97 === 0) {
          const tm = tPrev + (t - tPrev) * 0.375;
          interp(tm, out);
          samples.push([k - 1, tm, ...out]);
        }
      },
    });
    W.add('result', r.outcome, hex(r.reason), r.digest, r.steps, r.elapsed, r.finalT, r.deltaV, r.propellantUsed, r.totalDeltaV, String(r.finalState.length), r.finalState);
    for (const e of r.events) W.add('ev', e.kind, e.body, e.t, e.distance, e.altitude, e.speed, e.rel, e.mass, e.sphere ?? NaN);
    for (const b of r.burns) W.add('burn', b.burnTime, b.propellant, b.deltaV);
    for (const st of r.stages) W.add('stage', st.stage, st.propellantUsed, st.propellantLeft, st.deltaV, st.ascentDeltaV, st.separatedAt ?? NaN, st.droppedInAscent ? 1 : 0);
    if (r.launch) W.add('launch', r.launch.t, r.launch.state, r.launch.geocentric ?? [], r.launch.inclinationDeg ?? NaN);
    const a = r.ascent ?? r.directAscent;
    if (a) W.add('ascent', a.upperStage, a.upperPropellant, a.massAtInsertion, a.deltaV);
    for (const x of samples) W.add('sample', x);
    W.add('end', String(r.events.length), String(r.burns.length), String(r.stages.length), String(samples.length));
  };

  for (const c of replayCorpus(fp)) run(c.name, c.plan, c.opts);
  writeFileSync(OUT + 'replay.txt', W.text());
}, 3_600_000);
