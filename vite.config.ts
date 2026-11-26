import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
    // three.js alone is ~500 kB minified.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        check: resolve(import.meta.dirname, 'check.html'),
      },
    },
  },
  worker: { format: 'es' },
  // Several tests build real ephemeris chunks; the 5 s default is too tight on a loaded CI runner.
  test: { testTimeout: 30_000 },
});
