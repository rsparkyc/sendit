/**
 * TypeScript side of the leaderboard-path benchmark (`cargo run --release
 * --bin bench verify` and `node core/scripts/run-wasm.mjs bench-verify` are
 * the Rust sides): one chunk built cold from the checkpoint asset, every
 * campaign reference replay with its mission options (chunks warm, median
 * of 3 after one run), and the leaderboard verification end to end from a
 * fresh engine (server/leaderboard/engine.ts: asset install, decode,
 * checkRules, cold chunk building, replay, evaluate). Skipped unless BENCH=1.
 * Writes core/fixtures/generated/bench-verify-ts.txt.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { CAMPAIGN } from '../../src/mission/campaign';
import { decodePlan } from '../../src/mission/plan';
import { replay } from '../../src/mission/replay';
import { missionReplayOptions } from '../../src/mission/objectives';
import { ChebyshevEphemeris } from '../../src/physics/chebyshev-ephemeris';
import { installCheckpointAsset } from '../../src/physics/checkpoint-asset';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { realWorld } from '../../test/helpers/real-world';
import { createEngine } from '../../server/leaderboard/engine';

const ON = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH === '1';

it.skipIf(!ON)('leaderboard-path benchmark (TypeScript)', () => {
  const asset = new Uint8Array(readFileSync(new URL('../../src/physics/data/checkpoints-1950-2100.bin', import.meta.url)));
  const unhex = (s: string) => (s === '-' ? '' : Buffer.from(s, 'hex').toString('utf8'));
  const subs = readFileSync(new URL('../fixtures/generated/objectives.txt', import.meta.url), 'utf8').split('\n').filter((l, i, a) => l.startsWith('verify ') && a[i + 1]?.startsWith('accepted')).map((l) => l.split(' ')).filter((t) => t[4] !== '-')
    .map((t) => ({ plan: unhex(t[1]), id: unhex(t[2]), version: unhex(t[3]), site: t[4] }));
  const out: string[] = [];
  const log = (x: string) => out.push(x);
  const k0 = new ChebyshevEphemeris(J2000_BODIES).chunkIndex(CAMPAIGN[0].epoch);
  const ch: number[] = [];
  for (let r = 0; r < 6; r++) {
    const t0 = performance.now();
    const eph = new ChebyshevEphemeris(J2000_BODIES);
    installCheckpointAsset(eph, J2000_BODIES, asset);
    const t = eph.t0 + k0 * eph.layout.chunkSpan;
    eph.ensure(t, t);
    if (r > 0) ch.push(performance.now() - t0);
  }
  ch.sort((a, b) => a - b);
  log(`one chunk cold (asset decode + build chunk ${k0}): median ${ch[2].toFixed(1)} ms (range ${ch[0].toFixed(1)}..${ch[4].toFixed(1)})`);
  const { world } = realWorld();
  let tr = 0;
  let tv = 0;
  for (const s of subs) {
    const m = CAMPAIGN.find((x) => x.id === s.id)!;
    const plan = decodePlan(s.plan);
    const o = missionReplayOptions(m);
    const steps = replay(plan, world, o).steps;
    const rs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      replay(plan, world, o);
      rs.push(performance.now() - t0);
    }
    rs.sort((a, b) => a - b);
    const t0 = performance.now();
    const engine = createEngine({ checkpoints: asset });
    const mi = engine.mission(s.id)!;
    const p = engine.decode(s.plan);
    if (engine.checkRules(p, mi).length > 0) throw new Error('rules');
    const v = engine.verify(p, mi, { deadline: Date.now() + 1e9, maxSteps: 100_000 });
    const cold = performance.now() - t0;
    if (!v.success) throw new Error(`${s.id}/${s.site} not accepted`);
    tr += rs[1];
    tv += cold;
    log(`${s.id}/${s.site}: ${steps} steps, replay warm ${rs[1].toFixed(1)} ms, verify cold ${cold.toFixed(1)} ms`);
  }
  log(`total over ${subs.length} references: replay warm ${tr.toFixed(0)} ms, verify cold ${tv.toFixed(0)} ms`);
  writeFileSync(new URL('../fixtures/generated/bench-verify-ts.txt', import.meta.url), out.join('\n') + '\n');
}, 3_600_000);
