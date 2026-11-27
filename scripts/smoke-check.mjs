#!/usr/bin/env node
// Post-deploy smoke check against the live site (run by .github/workflows/deploy.yml; also by hand).
//
//   SITE_URL=https://<site> node scripts/smoke-check.mjs
//
// Needs `pnpm build:leaderboard` (for the expected catalogue) and Playwright's Chromium
// (`pnpm exec playwright install chromium`). Checks, failing loudly on the first that does not hold:
//   1. GET /api/leaderboard/missions serves exactly this commit's physics version and mission versions
//      (from `node dist-server/leaderboard/admin.mjs missions`). Polled for up to SMOKE_WAIT_S seconds
//      (default 240): CloudFront may cache the reply for up to 60 s.
//   2. The game page (/) loads with no console errors and no uncaught page errors.
//   3. /check.html reports PASS overall, and its model-2 replay and staged (launch-vehicle) replay each
//      report PASS with this commit's physics model and data fingerprint.
// Writes a Markdown report to $GITHUB_STEP_SUMMARY when set. Exit code 0 only if every check passed.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(SITE_URL)) {
  console.error('SITE_URL must be https://<host> (no path)');
  process.exit(2);
}
const WAIT_S = Number(process.env.SMOKE_WAIT_S ?? 240);
const CHECK_TIMEOUT_MS = 180_000;

const lines = ['### Post-deploy smoke check', `Site: ${SITE_URL}`, ''];
let failed = false;
const ok = (s) => { console.log(`PASS ${s}`); lines.push(`- PASS ${s}`); };
const bad = (s) => { console.error(`FAIL ${s}`); lines.push(`- **FAIL** ${s}`); failed = true; };
const done = () => {
  lines.push('', failed ? '**Smoke check FAILED: the live site does not match this commit. See README, "If a deploy fails".**' : 'All checks passed.');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exit(failed ? 1 : 0);
};

// --- 1. leaderboard missions -------------------------------------------------------------------------
const admin = execFileSync('node', ['dist-server/leaderboard/admin.mjs', 'missions'], { encoding: 'utf8' }).trim().split('\n');
const physics = /^physics (\S+)$/.exec(admin[0] ?? '')?.[1];
if (!physics) throw new Error(`unexpected admin.mjs output: ${admin.join('\n')}`);
const [model, data] = [physics.slice(0, physics.indexOf('.')), physics.slice(physics.indexOf('.') + 1)];
const want = admin.slice(1).map((l) => l.split('\t').slice(0, 2).join('@')).sort();

const deadline = Date.now() + WAIT_S * 1000;
let last = '';
for (;;) {
  try {
    const res = await fetch(`${SITE_URL}/api/leaderboard/missions`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    const gotPhysics = `${b.physics?.model}.${b.physics?.data}`;
    const got = (b.missions ?? []).map((m) => `${m.id}@${m.version}`).sort();
    if (gotPhysics === physics && JSON.stringify(got) === JSON.stringify(want)) { last = ''; break; }
    last = `serves physics ${gotPhysics}, missions ${got.join(' ')}; expected physics ${physics}, missions ${want.join(' ')}`;
  } catch (e) {
    last = `GET /api/leaderboard/missions: ${e.message}`;
  }
  if (Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 15_000));
}
if (last) bad(`leaderboard ${last} (after ${WAIT_S} s)`);
else ok(`leaderboard serves physics \`${physics}\` and ${want.length} mission versions: ${want.map((w) => `\`${w}\``).join(', ')}`);

// --- 2 and 3. pages ----------------------------------------------------------------------------------
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  const res = await page.goto(`${SITE_URL}/`, { waitUntil: 'load', timeout: 60_000 });
  // Let the app start (workers, first frame) so start-up errors surface.
  await page.waitForTimeout(10_000);
  if (!res?.ok()) bad(`/ answered HTTP ${res?.status()}`);
  else if (errors.length) bad(`/ loaded with errors:\n${errors.map((e) => `  - \`${e}\``).join('\n')}`);
  else ok('/ loads with no console or page errors');

  errors.length = 0;
  await page.goto(`${SITE_URL}/check.html`, { waitUntil: 'load', timeout: 60_000 });
  const finished = await page
    .waitForFunction(() => document.body.dataset.result !== undefined && document.body.dataset.model2 !== undefined && document.body.dataset.staged !== undefined, null, { timeout: CHECK_TIMEOUT_MS })
    .then(() => true, () => false);
  const r = await page.evaluate(() => ({ result: document.body.dataset.result, error: document.body.dataset.error, model2: document.body.dataset.model2, staged: document.body.dataset.staged, verdict: document.getElementById('verdict')?.textContent }));
  if (!finished) bad(`/check.html gave no result within ${CHECK_TIMEOUT_MS / 1000} s (shows: ${r.verdict})`);
  else {
    const m2 = JSON.parse(r.model2);
    const st = JSON.parse(r.staged);
    if (r.result === 'PASS') ok('/check.html determinism scenario: PASS');
    else bad(`/check.html determinism scenario: ${r.result} ${r.error ?? ''}`);
    for (const [name, x] of [['model-2 replay', m2], ['staged replay', st]]) {
      const match = String(x.model) === model && x.data === data;
      if (x.verdict === 'PASS' && match) ok(`/check.html ${name}: PASS (model ${x.model}, data ${x.data}, digest ${x.digest})`);
      else bad(`/check.html ${name}: ${x.verdict}${x.error ? ` (${x.error})` : ''}, model ${x.model} data ${x.data}; expected PASS with model ${model} data ${data}`);
    }
    if (r.verdict?.trim() !== 'PASS') bad(`/check.html headline shows "${r.verdict}"`);
    if (errors.length) bad(`/check.html logged errors:\n${errors.map((e) => `  - \`${e}\``).join('\n')}`);
  }
} finally {
  await browser.close();
}
done();
