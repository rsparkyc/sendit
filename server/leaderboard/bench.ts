/**
 * Latency measurement (bundled to dist-server/leaderboard/bench.mjs; run with
 * `pnpm bench:leaderboard`). Each scenario runs in its own fresh process so
 * "cold" includes module load, checkpoint install and every chunk build, as
 * a cold Lambda would; "warm" re-flies in the same process (chunks cached,
 * score cache bypassed).
 *
 *   node dist-server/leaderboard/bench.mjs <scenario>    scenario: lunar | longest-leo | longest-escape | chunk
 */
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
