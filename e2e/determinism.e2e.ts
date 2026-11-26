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
