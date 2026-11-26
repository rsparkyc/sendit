import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ChunkDigest } from './ephemeris-digest';

// The Node reference runs the Vite SSR bundle of ephemeris-digest.ts (built by the
// webServer step), so JSON imports resolve exactly as in the browser build.
const nodeBundle = pathToFileURL(resolve(import.meta.dirname, '.dist-node/ephemeris-digest.js')).href;

// No stored golden value: the ephemeris internals are still changing. Each
// engine is compared against Node (V8) computed in this same run.
let nodeResult: Promise<{ chunks: ChunkDigest[]; ms: number }> | undefined;

// Two chunks of 29 bodies with gravity fields: measured 0.9-2.5 s per engine on the 2-core CI runner (Firefox
// 1.4 s), up to 6.4 s on 2 CPUs under Docker with other tests running. 60 s leaves ~10x margin; the page sets
// data-error on every failure path, so a broken run fails at once with the reason instead.
const EPHEMERIS_TIMEOUT_MS = 60_000;

test('Chebyshev chunks 0 and -1 match Node bit for bit', async ({ page, browser }, info) => {
  nodeResult ??= import(nodeBundle).then((m) => m.ephemerisDigest());
  const seen: string[] = [];
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') seen.push(`console.${m.type()}: ${m.text()}`);
  });
  const t0 = Date.now();
  await page.goto('http://localhost:4174/');
  const done = await page
    .waitForFunction(() => document.body.dataset.digest || document.body.dataset.error, null, { timeout: EPHEMERIS_TIMEOUT_MS })
    .then(() => true, () => false);
  const pageMs = Date.now() - t0;
  const { err, digest } = await page.evaluate(() => ({ err: document.body.dataset.error, digest: document.body.dataset.digest }));
  const browserResult = digest ? (JSON.parse(digest) as { chunks: ChunkDigest[]; ms: number }) : null;
  const node = await nodeResult;
  const fmt = (r: { chunks: ChunkDigest[]; ms: number }) =>
    r.chunks.map((c) => `chunk ${String(c.chunk).padStart(2)} len ${c.length} sha256 ${c.sha256}`).join('\n    ') + ` (${r.ms.toFixed(0)} ms)`;
  const got = browserResult ? fmt(browserResult) : err ? `ERROR ${err}` : `no result after ${EPHEMERIS_TIMEOUT_MS} ms`;
  const summary = `[${info.project.name} ${browser.version()}] page ${pageMs} ms\n  browser: ${got}\n  node ${process.version}: ${fmt(node)}` +
    (seen.length ? `\n  page said:\n    ${seen.join('\n    ')}` : '');
  console.log(summary);
  await info.attach('ephemeris-digest', { body: summary, contentType: 'text/plain' });
  expect(done, summary).toBe(true);
  expect(err, summary).toBeUndefined();
  expect(browserResult!.chunks, summary).toEqual(node.chunks);
});
