import { expect, it } from 'vitest';
import { sandboxSpheres } from './replay-options';
import { f64Hex } from './staged-replay-hex';

const FS = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ FS)) as { readFileSync: (u: URL, enc: 'utf8') => string };

// The sandbox sphere-of-influence radii are replay inputs (sphere enter/exit
// event times, hence the digest). They are computed from exactly defined
// arithmetic only: a = sqrt(dx*dx + dy*dy + dz*dz) (written-out sum, in that
// order) and r = a * exactExp(0.4 * exactLn(m / M)), so every engine and the
// Rust port in core/ get these bits. (The earlier Math.hypot / Math.pow
// formulation, V8 bits, differed by up to 6 ulp, max relative 7.6e-16.)
const PINNED: [string, string][] = [
  ['mercury', '41a025ddd2ae1a96'], ['venus', '41c2498c4d3eac58'], ['earth', '41cb18e15e7fc881'], ['moon', '419085266882f040'],
  ['mars', '41bf6a0679364e5d'], ['jupiter', '42256c3abe36229b'], ['saturn', '422875ba609fa30c'], ['uranus', '422906c052fe2c78'],
  ['neptune', '423435b62ff9b5fd'], ['pluto', '41e1f225aafdcf59'], ['io', '415dc82e28287045'], ['europa', '416260a5d5518dd9'],
  ['ganymede', '417738407f2f8f41'], ['callisto', '4181f53d68f199f9'], ['tethys', '4132818f7129157c'], ['dione', '413dc0216521712d'],
  ['rhea', '414c1039f7660c6f'], ['titan', '418539d54d39c496'], ['iapetus', '4176025a801013d3'], ['enceladus', '411da1c75146df74'],
  ['ariel', '4140e0bc878e5705'], ['umbriel', '4147b35c44ffdd6e'], ['titania', '415c8164cb7f927c'], ['oberon', '4162c761f214612b'],
  ['miranda', '411b79bb88ace69a'], ['triton', '4166d2951b2ac3a3'], ['charon', '41601dc9a732b8b6'],
];

it('pins the sandbox sphere-of-influence radii bit for bit', () => {
  expect(sandboxSpheres().map((s) => [s.body, f64Hex(s.radius)])).toEqual(PINNED);
});

it('computes the radii without implementation-approximated Math functions', () => {
  const src = readFileSync(new URL('./replay-options.ts', import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
  for (const f of ['pow', 'hypot', 'exp', 'log', 'cbrt', 'expm1', 'log1p', 'log2', 'log10']) {
    expect(src, `Math.${f} in replay-options.ts`).not.toMatch(new RegExp(`Math\\.${f}\\b`));
  }
});
