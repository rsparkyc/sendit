import { defineConfig, devices } from '@playwright/test';

// Cross-engine browser tests. Kept apart from the vitest unit tests: files here
// are named *.e2e.ts so vitest's default *.test/*.spec glob never picks them up.
const SITE_PORT = 4173;
const EPH_PORT = 4174;

// CI splits the run (see .github/workflows/ci.yml); with neither variable set, everything runs as before.
//   PW_SUITE=engines  the cross-engine determinism files only (determinism, ephemeris), for any --project
//   PW_SUITE=ui       every other file (the Chromium-only UI suites), without the ephemeris server
//   PW_PREBUILT=1     serve the existing dist/ (e.g. a build artifact) instead of running `pnpm build` first
const ENGINE_FILES = ['**/determinism.e2e.ts', '**/ephemeris.e2e.ts'];
const SUITE = process.env.PW_SUITE ?? '';
if (!['', 'engines', 'ui'].includes(SUITE)) throw new Error(`PW_SUITE must be engines or ui, not ${SUITE}`);
const PREBUILT = process.env.PW_PREBUILT === '1';

// Test-only ephemeris digest page built from e2e/ephemeris-page, plus a Node
// (SSR) bundle of the same digest code for the in-run V8 reference.
const EPHEMERIS_SERVER = {
  command: `pnpm exec vite build --config e2e/vite.ephemeris.config.ts && pnpm exec vite build --config e2e/vite.ephemeris.config.ts --ssr ../ephemeris-digest.ts --outDir ../.dist-node && pnpm exec vite preview --config e2e/vite.ephemeris.config.ts --port ${EPH_PORT} --strictPort`,
  cwd: '..',
  url: `http://localhost:${EPH_PORT}/`,
  // Never reuse a server already on the port: a stale preview once made the tests run against an old
  // build. If the port is taken, Playwright stops with an error instead. Playwright stops the servers it
  // started when the run ends (also on failure or Ctrl-C).
  reuseExistingServer: false,
  timeout: 180_000,
};

export default defineConfig({
  testDir: '.',
  testMatch: SUITE === 'engines' ? ENGINE_FILES : '**/*.e2e.ts',
  testIgnore: SUITE === 'ui' ? ENGINE_FILES : undefined,
  timeout: 180_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // No retries: a flaky test fails the run. On CI the blob report lets the shards be merged into one HTML
  // report, and the github reporter annotates each failure on the run's summary page.
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }], ['blob']] : [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Headless Firefox on Linux has no WebGL whatever the prefs (webgl.force-enabled etc. still end in
    // FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS); headed Firefox under Xvfb gets Mesa llvmpipe. So on Linux CI run
    // `PW_FIREFOX_HEADED=1 xvfb-run -a pnpm test:browsers` to give Firefox the full smoke set; without it only the
    // load test runs there (smoke.e2e.ts skips the rest, saying why). macOS headless Firefox has WebGL.
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...(process.env.PW_FIREFOX_HEADED ? { headless: false } : {}) } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      // The real production build of the site, served statically.
      command: `${PREBUILT ? '' : 'pnpm build && '}pnpm exec vite preview --port ${SITE_PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${SITE_PORT}/`,
      // Never reuse a server already on the port: a stale preview once made the tests run against an old
      // build. If the port is taken, Playwright stops with an error instead. Playwright stops the servers it
      // started when the run ends (also on failure or Ctrl-C).
      reuseExistingServer: false,
      timeout: 180_000,
    },
    ...(SUITE === 'ui' ? [] : [EPHEMERIS_SERVER]),
  ],
});
