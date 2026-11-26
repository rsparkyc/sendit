import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds the test-only page in e2e/ephemeris-page to e2e/.dist-ephemeris.
export default defineConfig({
  root: resolve(import.meta.dirname, 'ephemeris-page'),
  configFile: false,
  logLevel: 'warn',
  build: { outDir: resolve(import.meta.dirname, '.dist-ephemeris'), emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
});
