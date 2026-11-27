// Runs the parity-vector exporter (core/ts/*.vec.ts), not part of `pnpm test`.
// `pnpm core:vectors` writes core/fixtures/generated/ (gitignored).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: new URL('../..', import.meta.url).pathname,
  test: { include: ['core/ts/**/*.vec.ts'], testTimeout: 1_200_000, hookTimeout: 1_200_000, fileParallelism: false },
});
