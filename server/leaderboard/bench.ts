/**
 * Latency measurement (bundled to dist-server/leaderboard/bench.mjs; run with
 * `pnpm bench:leaderboard`). Each scenario runs in its own fresh process so
 * "cold" includes module load, checkpoint install and every chunk build, as
 * a cold Lambda would; "warm" re-flies in the same process (chunks cached,
 * score cache bypassed).
 *
 *   node dist-server/leaderboard/bench.mjs <scenario>    scenario: lunar | longest-leo | longest-escape | chunk | ascent | checks
 *
 * `ascent`: the ascent model alone for every campaign vehicle (what a vehicle
 * launch adds to every replay). `checks`: the work done before any replay:
 * decoding and the mission-rule check of the largest staged plan allowed.
 */
import { CAMPAIGN } from '../../src/mission/campaign';
import { ASCENT_BODIES, computeAscent } from '../../src/mission/ascent';
import { launchGeometry, launchSite } from '../../src/mission/launch';
import { vehicleStages } from '../../src/mission/plan';
import { createEngine } from './engine';
import { encodePlan, fixtures } from './fixtures';
import { readAsset } from './node-io';

const t0 = performance.now();
const bytes = await readAsset('checkpoints.bin', import.meta.url);
const engine = createEngine({ checkpoints: bytes, maxChunks: 400 });
const tInit = performance.now() - t0;
const fx = fixtures(bytes);
const scenario = process.argv[2] ?? 'lunar';
const mission = engine.mission('lunar-free-return')!;
const rec: Record<string, unknown> = { scenario, initMs: Math.round(tInit) };

function run(label: string, plan: ReturnType<typeof fx.freeReturn>, maxSteps: number) {
  const encoded = encodePlan(plan);
  const a = performance.now();
  const p = engine.decode(encoded);
  const decodeMs = performance.now() - a;
  const chunks = engine.missingChunks(p);
  const b = performance.now();
  const v = engine.verify(p, mission, { deadline: Date.now() + 600_000, maxSteps });
  rec[label] = { encodedChars: encoded.length, decodeMs: +decodeMs.toFixed(2), chunksBuilt: chunks, ms: Math.round(performance.now() - b), steps: v.steps, status: v.status, outcome: v.outcome, success: v.success, score: v.score };
}

if (scenario === 'chunk') {
  // One chunk build from its checkpoint, repeated.
  const p = fx.longest(engine.fingerprint, true);
  const a = performance.now();
  const n = engine.missingChunks(p);
  engine.verify({ ...p, duration: 1, burns: [] } as typeof p, mission, { deadline: Date.now() + 600_000, maxSteps: 10 });
  rec.firstChunkMs = Math.round(performance.now() - a);
  rec.spanChunks = n;
} else if (scenario === 'ascent') {
  const earth = { gm: 3.986004418e14, radius: 6378136.6 };
  const out: Record<string, number> = {};
  for (const m of CAMPAIGN) {
    const p = engine.decode(encodePlan({ ...fx.freeReturn(engine.fingerprint), spacecraft: m.spacecraft, lowerStages: m.rules.vehicle!.lowerStages }));
    const st = p.start as { site: string; params: readonly number[] };
    const n = 200;
    const a = performance.now();
    for (let i = 0; i < n; i++) computeAscent(vehicleStages(p), { ...earth, altitudeM: 180e3 + i * 4e3 }, launchGeometry(launchSite(st.site), st.params[0], st.params[1]), ASCENT_BODIES.earth);
    out[m.id] = +((performance.now() - a) / n).toFixed(3);
  }
  rec.ascentMsPerCall = out;
} else if (scenario === 'checks') {
  const enc = encodePlan(fx.largestStaged(engine.fingerprint));
  const m = engine.mission('jupiter-saturn')!;
  const n = 200;
  let a = performance.now();
  for (let i = 0; i < n; i++) engine.decode(enc);
  rec.decodeLargestStagedMs = +((performance.now() - a) / n).toFixed(3);
  const p = engine.decode(enc);
  a = performance.now();
  for (let i = 0; i < n; i++) engine.checkRules(p, m);
  rec.checkRulesMs = +((performance.now() - a) / n).toFixed(3);
  rec.encodedChars = enc.length;
} else if (scenario === 'plan') {
  // node bench.mjs plan <mission-id> <encoded plan>: any plan, e.g. a reference solution kept out of the repo.
  const m = engine.mission(process.argv[3])!;
  const p = engine.decode(process.argv[4]);
  for (const label of ['cold', 'warm']) {
    const chunks = engine.missingChunks(p);
    const b = performance.now();
    const v = engine.verify(p, m, { deadline: Date.now() + 600_000, maxSteps: 250_000 });
    rec[label] = { chunksBuilt: chunks, ms: Math.round(performance.now() - b), steps: v.steps, status: v.status, success: v.success, score: v.score, rules: engine.checkRules(p, m).length };
  }
} else {
  const plan = scenario === 'lunar' ? fx.freeReturn(engine.fingerprint) : fx.longest(engine.fingerprint, scenario === 'longest-escape');
  const maxSteps = Number(process.argv[3] ?? 1_000_000);
  run('cold', plan, maxSteps);
  run('warm', plan, maxSteps);
}
const mem = (globalThis as unknown as { process: { memoryUsage(): { rss: number } } }).process.memoryUsage();
rec.rssMB = Math.round(mem.rss / 1e6);
rec.totalMs = Math.round(performance.now() - t0);
process.stdout.write(`${JSON.stringify(rec)}\n`);
