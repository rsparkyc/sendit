import { expect, test, type Page } from '@playwright/test';

const BASE = 'http://localhost:4173';

/** The diagnostic moved from / to /check.html; try the new location first. */
async function diagnosticUrl(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/check.html`);
  if (res.ok() && (await res.text()).includes('determinism')) return `${BASE}/check.html`;
  return `${BASE}/`;
}

/** Page errors and console errors, so a failure log says what the page saw. */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') seen.push(`console.${m.type()}: ${m.text()}`);
  });
  page.on('requestfailed', (r) => seen.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  return seen;
}

test('mission replay is bit-identical to the V8 reference', async ({ page, request, browser }, info) => {
  const url = await diagnosticUrl(request);
  const seen = watch(page);
  const t0 = Date.now();
  await page.goto(url);
  // The page always sets data-result, also on a worker error (with data-error), so this does not wait out a hang.
  await page.waitForFunction(() => document.body.dataset.result !== undefined || document.querySelector('#verdict.fail'), null, {
    timeout: 60_000,
  });
  const result = await page.evaluate(() => ({
    result: document.body.dataset.result ?? null,
    error: document.body.dataset.error ?? null,
    title: document.title,
    verdict: document.getElementById('verdict')?.textContent ?? '',
    ua: navigator.userAgent,
    time: document.getElementById('time')?.textContent ?? '',
    rows: Array.from(document.querySelectorAll('#rows tr'), (tr) => Array.from(tr.children, (td) => td.textContent ?? '')),
  }));
  const table = result.rows.map(([name, got, want, status, diff]) => `  ${name.padEnd(9)} got ${got} want ${want} ${status} ${diff}`).join('\n');
  const summary = `[${info.project.name} ${browser.version()}] ${url}\n  ${result.verdict} (worker ${result.time}, page ${Date.now() - t0} ms)\n  UA: ${result.ua}\n${table}${seen.length ? `\n  page said:\n    ${seen.join('\n    ')}` : ''}`;
  console.log(summary);
  await info.attach('determinism', { body: summary, contentType: 'text/plain' });
  expect(result.result, summary).toBe('PASS');
});

// The model-2 replay runs on the diagnostic page (no WebGL), not in the app: headless Firefox on Linux has no
// WebGL at all, so the app cannot start there (it once waited out a 2-minute timeout on that).
// Measured worker time for the whole check (checkpoint asset, one chunk, the replay): 0.5-0.8 s per engine on
// a fast laptop, 2-9 s on 2 CPUs under Docker with other tests running. 60 s is 6x the slowest of those.
const MODEL2_TIMEOUT_MS = 60_000;

test('a model-2 mission replay (real ephemeris, Earth and Moon fields) gives the V8 digest', async ({ page, browser }, info) => {
  const { DATA, DIGEST, MODEL } = await import('../src/fixtures/model2-replay');
  const seen = watch(page);
  const t0 = Date.now();
  await page.goto(`${BASE}/check.html`);
  // data-model2 is set on success and on every failure path (worker error, failed asset fetch, rejection).
  const ok = await page
    .waitForFunction(() => document.body.dataset.model2 !== undefined, null, { timeout: MODEL2_TIMEOUT_MS })
    .then(() => true, () => false);
  const { raw, shown } = await page.evaluate(() => ({ raw: document.body.dataset.model2 ?? null, shown: document.getElementById('m2-verdict')?.textContent ?? '' }));
  const got = raw ? (JSON.parse(raw) as Record<string, unknown>) : { verdict: 'FAIL', error: `no result after ${MODEL2_TIMEOUT_MS} ms (page shows: ${shown})` };
  const ms = (k: string) => (typeof got[k] === 'number' ? `${(got[k] as number).toFixed(0)} ms` : '?');
  const timing = 'totalMs' in got
    ? `worker ${ms('totalMs')} (checkpoint asset ${ms('fetchMs')}, ${got.chunks} chunk(s) ${ms('chunkMs')}, replay ${ms('replayMs')}), page ${Date.now() - t0} ms`
    : `page ${Date.now() - t0} ms`;
  const summary = `[${info.project.name} ${browser.version()}] model-2 replay ${got.verdict}: ` +
    ('error' in got ? `error ${got.error}` : `model ${got.model} data ${got.data} digest ${got.digest} ${got.outcome}`) +
    ` (V8: model ${MODEL} data ${DATA} digest ${DIGEST})\n  ${timing}${seen.length ? `\n  page said:\n    ${seen.join('\n    ')}` : ''}`;
  console.log(summary);
  await info.attach('model2-replay', { body: summary, contentType: 'text/plain' });
  expect(ok, summary).toBe(true);
  expect({ model: got.model, data: got.data, digest: got.digest, outcome: got.outcome }, summary).toEqual({ model: MODEL, data: DATA, digest: DIGEST, outcome: 'completed' });
});

test('a staged replay with a launch-vehicle ascent gives the V8 digest and ascent bits', async ({ page, browser }, info) => {
  const { ASCENT_HEX, DATA, DIGEST, MODEL } = await import('../src/fixtures/staged-replay');
  const seen = watch(page);
  const t0 = Date.now();
  await page.goto(`${BASE}/check.html`);
  // data-staged is set on success and on every failure path, like data-model2.
  const ok = await page
    .waitForFunction(() => document.body.dataset.staged !== undefined, null, { timeout: MODEL2_TIMEOUT_MS })
    .then(() => true, () => false);
  const { raw, shown } = await page.evaluate(() => ({ raw: document.body.dataset.staged ?? null, shown: document.getElementById('st-verdict')?.textContent ?? '' }));
  const got = raw ? (JSON.parse(raw) as Record<string, unknown>) : { verdict: 'FAIL', error: `no result after ${MODEL2_TIMEOUT_MS} ms (page shows: ${shown})` };
  const ms = (k: string) => (typeof got[k] === 'number' ? `${(got[k] as number).toFixed(0)} ms` : '?');
  const summary = `[${info.project.name} ${browser.version()}] staged replay ${got.verdict}: ` +
    ('error' in got ? `error ${got.error}` : `model ${got.model} data ${got.data} digest ${got.digest} ${got.outcome} ascent ${JSON.stringify(got.ascent)}`) +
    ` (V8: model ${MODEL} data ${DATA} digest ${DIGEST} ascent ${JSON.stringify(ASCENT_HEX)})\n  worker ${ms('totalMs')} (replay ${ms('replayMs')}), page ${Date.now() - t0} ms` +
    `${seen.length ? `\n  page said:\n    ${seen.join('\n    ')}` : ''}`;
  console.log(summary);
  await info.attach('staged-replay', { body: summary, contentType: 'text/plain' });
  expect(ok, summary).toBe(true);
  expect({ model: got.model, data: got.data, digest: got.digest, outcome: got.outcome, ascent: got.ascent }, summary).toEqual({ model: MODEL, data: DATA, digest: DIGEST, outcome: 'completed', ascent: ASCENT_HEX });
});
