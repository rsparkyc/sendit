import { defineConfig, devices } from '@playwright/test';

// Cross-engine browser tests. Kept apart from the vitest unit tests: files here
// are named *.e2e.ts so vitest's default *.test/*.spec glob never picks them up.
const SITE_PORT = 4173;
const EPH_PORT = 4174;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      // The real production build of the site, served statically.
      command: `pnpm build && pnpm exec vite preview --port ${SITE_PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${SITE_PORT}/`,
      // Never reuse a server already on the port: a stale preview once made the tests run against an old
      // build. If the port is taken, Playwright stops with an error instead. Playwright stops the servers it
      // started when the run ends (also on failure or Ctrl-C).
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // Test-only ephemeris digest page built from e2e/ephemeris-page, plus a Node
      // (SSR) bundle of the same digest code for the in-run V8 reference.
      command: `pnpm exec vite build --config e2e/vite.ephemeris.config.ts && pnpm exec vite build --config e2e/vite.ephemeris.config.ts --ssr ../ephemeris-digest.ts --outDir ../.dist-node && pnpm exec vite preview --config e2e/vite.ephemeris.config.ts --port ${EPH_PORT} --strictPort`,
      cwd: '..',
      url: `http://localhost:${EPH_PORT}/`,
      // Never reuse a server already on the port: a stale preview once made the tests run against an old
      // build. If the port is taken, Playwright stops with an error instead. Playwright stops the servers it
      // started when the run ends (also on failure or Ctrl-C).
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
