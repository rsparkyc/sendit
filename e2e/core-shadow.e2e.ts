import { expect, test } from '@playwright/test';

// The Rust core behind its feature flag (src/app/core-flag.ts): off by default (the module is never fetched),
// and with ?core=shadow every full replay the game flies is also flown in the core and compared bit for bit.
const BASE = 'http://localhost:4173';

test('the Rust core is off by default: the module is never fetched', async ({ page }) => {
  const wasm: string[] = [];
  page.on('request', (r) => { if (r.url().endsWith('.wasm')) wasm.push(r.url()); });
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => ((window as any).sendit?.replayStats?.runs ?? 0) > 0, null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).sendit.coreStats.mode)).toBe('off');
  expect(wasm).toEqual([]);
});

test('?core=shadow: the game\'s replays are bit-identical in the Rust core', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => { if (m.type() === 'warning' && m.text().includes('sendit core')) warnings.push(m.text()); });
  await page.goto(`${BASE}/?core=shadow`);
  await page.waitForFunction(() => {
    const c = (window as any).sendit?.coreStats;
    return c && (c.compared > 0 || c.errors > 0);
  }, null, { timeout: 90_000 });
  const c = await page.evaluate(() => ({ ...(window as any).sendit.coreStats }));
  expect({ mode: c.mode, mismatches: c.mismatches, errors: c.errors, warnings }, JSON.stringify(c)).toEqual({ mode: 'shadow', mismatches: 0, errors: 0, warnings: [] });
  expect(c.compared).toBeGreaterThan(0);
});
