#!/usr/bin/env node
// CI only (.github/workflows/ci.yml, job "report"): turns the merged Playwright JSON report into the run's
// summary: totals, and one row per failed or flaky test with the job artifact that holds its trace.
//   node scripts/ci-browser-summary.mjs merged.json
import { appendFileSync, readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const s = r.stats ?? {};
const rows = [];
const walk = (suite, path) => {
  for (const sp of suite.specs ?? []) {
    for (const t of sp.tests ?? []) {
      if (t.status !== 'unexpected' && t.status !== 'flaky') continue;
      const job = ['chromium', 'firefox', 'webkit'].includes(t.projectName) && /(determinism|ephemeris)\.e2e\.ts$/.test(sp.file)
        ? `engines-${t.projectName}` : 'ui-<shard>';
      rows.push(`| ${t.status === 'flaky' ? 'flaky (passed on retry)' : '**failed**'} | ${t.projectName} | ${[...path, sp.title].filter(Boolean).join(' › ')} | \`${sp.file}:${sp.line}\` | playwright-report-${job} |`);
    }
  }
  for (const c of suite.suites ?? []) walk(c, [...path, c.title]);
};
for (const su of r.suites ?? []) walk(su, []);

const lines = [
  '### Browser tests',
  `${s.expected ?? 0} passed, ${s.unexpected ?? 0} failed, ${s.flaky ?? 0} flaky, ${s.skipped ?? 0} skipped.`,
  `Jobs: engines ${process.env.ENGINES ?? '?'}, ui ${process.env.UI ?? '?'}.`,
];
if (rows.length) {
  lines.push('', '| result | project | test | where | artifact |', '|---|---|---|---|---|', ...rows, '',
    'The merged HTML report of every job is the artifact **playwright-report**; each failing job also uploads its own report and traces (artifact column). Both are on this run\'s Summary page under Artifacts.');
}
const text = `${lines.join('\n')}\n`;
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
