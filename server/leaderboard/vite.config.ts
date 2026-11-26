/**
 * Bundle the leaderboard Lambda (and the admin / bench scripts) with the
 * mission and physics code into self-contained ES modules for Node 22, plus
 * the checkpoint asset copied next to them as checkpoints.bin.
 *
 *   pnpm build:leaderboard  ->  dist-server/leaderboard/{handler,admin,bench}.mjs, checkpoints.bin
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = resolve(import.meta.dirname, '../..');

const checkpointAsset = (): Plugin => ({
  name: 'leaderboard-checkpoint-asset',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'checkpoints.bin', source: readFileSync(resolve(root, 'src/physics/data/checkpoints-1950-2100.bin')) });
  },
});

export default defineConfig({
  root,
  publicDir: false,
  logLevel: 'warn',
  plugins: [checkpointAsset()],
  build: {
    ssr: true,
    target: 'node22',
    outDir: resolve(root, 'dist-server/leaderboard'),
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    // Inline nothing as base64: the only asset is copied explicitly above.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        handler: resolve(root, 'server/leaderboard/lambda.ts'),
        admin: resolve(root, 'server/leaderboard/admin.ts'),
        bench: resolve(root, 'server/leaderboard/bench.ts'),
      },
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
