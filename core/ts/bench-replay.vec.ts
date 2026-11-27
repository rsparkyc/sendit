/**
 * TypeScript side of the replay benchmark (`cargo run --release --bin bench
 * mission` is the Rust side): the same plans from replay.txt with default
 * options, chunks warm, median of 5 after one warm-up. Skipped unless
 * BENCH=1 (it is not a vector exporter).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { decodePlan } from '../../src/mission/plan';
import { replay } from '../../src/mission/replay';
import { computeAscent } from '../../src/mission/ascent';
import { ASCENT_BODIES } from '../../src/mission/ascent';
import { VEHICLES } from '../../src/mission/vehicles';
import { J2000_BODIES } from '../../src/physics/solar-system';
import { realWorld } from '../../test/helpers/real-world';

const ON = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH === '1';

it.skipIf(!ON)('replay benchmark (TypeScript)', () => {
  const { world } = realWorld();
  const text = readFileSync(new URL('../fixtures/generated/replay.txt', import.meta.url), 'utf8');
  const med = (f: () => void, reps = 5) => {
    f();
    const t: number[] = [];
    for (let i = 0; i < reps; i++) {
      const a = performance.now();
      f();
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    return t[Math.floor(t.length / 2)];
  };
  const out: string[] = [];
  const log = (x: string) => out.push(x);
  const earth = J2000_BODIES.find((b) => b.id === 'earth')!;
  const stack = [...VEHICLES[0].stages, { wetMass: 2000, dryMass: 600, engines: [{ thrust: 4000, isp: 320 }] }];
  log(`computeAscent (Falcon 9, 250 km): ${med(() => computeAscent(stack, { gm: earth.gm, radius: earth.referenceRadius, altitudeM: 250e3 }, { alongTrack: 400, crossTrack: 50 }, ASCENT_BODIES.earth), 10).toFixed(2)} ms`);
  for (const name of ['model2-nospheres', 'staged', 'lunar-free-return/cape-canaveral', 'venus-flyby/cape-canaveral']) {
    const line = text.split('\n').find((l) => l.startsWith(`replay ${name} `))!;
    const plan = decodePlan(line.split(' ')[2]);
    let steps = 0;
    const ms = med(() => { steps = replay(plan, world, {}).steps; });
    log(`replay ${name} (${steps} steps, chunks warm): ${ms.toFixed(1)} ms`);
  }
  writeFileSync(new URL('../fixtures/generated/bench-ts.txt', import.meta.url), out.join('\n') + '\n');
}, 600_000);
