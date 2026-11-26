// Generates src/physics/data/checkpoints-1950-2100.bin: the integrator
// checkpoint at every chunk boundary from 1950 to 2100 (see
// src/physics/checkpoint-asset.ts). Run with `pnpm gen:checkpoints` (~80 s).
// Loads the TypeScript sources through Vite's SSR module loader, so it runs
// exactly the code the site and the tests run.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const A = await server.ssrLoadModule('/src/physics/checkpoint-asset.ts');
  const { ChebyshevEphemeris } = await server.ssrLoadModule('/src/physics/chebyshev-ephemeris.ts');
  const { J2000_BODIES } = await server.ssrLoadModule('/src/physics/solar-system.ts');
  const eph = new ChebyshevEphemeris(J2000_BODIES);
  const { first, last } = A.assetBoundaries(eph.layout.chunkSpan);
  const t0 = Date.now();
  const cps = A.generateCheckpoints(eph, J2000_BODIES, first, last, (b) => {
    if (b % 20 === 0) process.stderr.write(`boundary ${b} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  });
  const bytes = A.encodeCheckpointAsset(A.assetHeaderFor(eph, J2000_BODIES), cps);
  const out = fileURLToPath(new URL('../src/physics/data/checkpoints-1950-2100.bin', import.meta.url));
  writeFileSync(out, bytes);
  console.log(`wrote ${out}: ${cps.length} checkpoints (boundaries ${first}..${last}), ${bytes.length} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await server.close();
}
