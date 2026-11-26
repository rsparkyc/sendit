import { expect, test } from '@playwright/test';

const BASE = 'http://localhost:4173';

/** The diagnostic moved from / to /check.html; try the new location first. */
async function diagnosticUrl(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/check.html`);
  if (res.ok() && (await res.text()).includes('determinism')) return `${BASE}/check.html`;
  return `${BASE}/`;
}

test('mission replay is bit-identical to the V8 reference', async ({ page, request, browser }, info) => {
  const url = await diagnosticUrl(request);
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.result !== undefined || document.querySelector('#verdict.fail'), null, {
    timeout: 150_000,
  });
  const result = await page.evaluate(() => ({
    result: document.body.dataset.result ?? null,
    title: document.title,
    verdict: document.getElementById('verdict')?.textContent ?? '',
    ua: navigator.userAgent,
    time: document.getElementById('time')?.textContent ?? '',
    rows: Array.from(document.querySelectorAll('#rows tr'), (tr) => Array.from(tr.children, (td) => td.textContent ?? '')),
  }));
  const table = result.rows.map(([name, got, want, status, diff]) => `  ${name.padEnd(9)} got ${got} want ${want} ${status} ${diff}`).join('\n');
  const summary = `[${info.project.name} ${browser.version()}] ${url}\n  ${result.verdict} (${result.time})\n  UA: ${result.ua}\n${table}`;
  console.log(summary);
  await info.attach('determinism', { body: summary, contentType: 'text/plain' });
  expect(result.result, summary).toBe('PASS');
});

test('a model-2 mission replay (real ephemeris, Earth and Moon fields) gives the V8 digest', async ({ page, browser }, info) => {
  const { DATA, DIGEST, MODEL, PLAN } = await import('../src/fixtures/model2-replay');
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => (window as any).sendit?.store.get().replayStatus === 'idle', null, { timeout: 120_000 });
  const got = await page.evaluate(async ([plan, model]) => {
    const w = (window as any).sendit;
    const cur = w.store.get().plan;
    if (cur.model !== model) return { error: `page runs physics model ${cur.model}` };
    w.editor.load('sandbox', { format: cur.format, model: cur.model, data: cur.data, ...plan });
    const t0 = performance.now();
    for (;;) {
      const s = w.store.get();
      if (s.replay && s.replay.plan === s.plan && s.replayStatus === 'idle') return { data: s.plan.data, digest: s.replay.result.digest, outcome: s.replay.result.outcome };
      if (performance.now() - t0 > 120_000) return { error: 'replay did not finish' };
      await new Promise((r) => setTimeout(r, 100));
    }
  }, [PLAN, MODEL] as const);
  const summary = `[${info.project.name} ${browser.version()}] model-2 replay: ${JSON.stringify(got)} (V8: data ${DATA}, digest ${DIGEST})`;
  console.log(summary);
  await info.attach('model2-replay', { body: summary, contentType: 'text/plain' });
  expect(got).toEqual({ data: DATA, digest: DIGEST, outcome: 'completed' });
});
