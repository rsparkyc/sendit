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

test('Chebyshev chunks 0 and -1 match Node bit for bit', async ({ page, browser }, info) => {
  nodeResult ??= import(nodeBundle).then((m) => m.ephemerisDigest());
  await page.goto('http://localhost:4174/');
  await page.waitForFunction(() => document.body.dataset.digest || document.body.dataset.error, null, { timeout: 170_000 });
  const err = await page.evaluate(() => document.body.dataset.error);
  expect(err, 'page error').toBeUndefined();
  const browserResult = JSON.parse((await page.evaluate(() => document.body.dataset.digest))!);
  const node = await nodeResult;
  const fmt = (r: { chunks: ChunkDigest[]; ms: number }) =>
    r.chunks.map((c) => `chunk ${String(c.chunk).padStart(2)} len ${c.length} sha256 ${c.sha256}`).join('\n    ') + ` (${r.ms.toFixed(0)} ms)`;
  const summary = `[${info.project.name} ${browser.version()}]\n  browser: ${fmt(browserResult)}\n  node ${process.version}: ${fmt(node)}`;
  console.log(summary);
  await info.attach('ephemeris-digest', { body: summary, contentType: 'text/plain' });
  expect(browserResult.chunks, summary).toEqual(node.chunks);
});
