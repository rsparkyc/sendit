#!/usr/bin/env node
// Release gate for the automatic deploy (.github/workflows/deploy.yml), run BEFORE anything is deployed.
//
//   SITE_URL=https://<site> node scripts/release-gate.mjs
//
// Compares what this commit's leaderboard bundle would serve (physics version and every mission
// version, from `node dist-server/leaderboard/admin.mjs missions`; run `pnpm build:leaderboard` first)
// with what the live server serves now (GET <SITE_URL>/api/leaderboard/missions).
//
// If the physics version or any existing mission's version differs, deploying empties those boards
// until an operator re-verifies the stored plans (README, "Re-verification"), and the deploy role
// deliberately cannot write the table. So the gate exits 1 and prints the commands a human must run,
// unless VERSION_CHANGE_ACKNOWLEDGED=1 (a manual dispatch by a person who will run them right after the
// deploy): then it exits 0 and prints the same commands as pending work.
// A new mission id (no stored entries) needs no re-verification and passes.
//
// Writes a Markdown report to $GITHUB_STEP_SUMMARY when set, and `reverify_pending=true|false` to
// $GITHUB_OUTPUT. Exit codes: 0 pass, 1 version change (stop), 2 usage or the live server unreadable.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(SITE_URL)) {
  console.error('SITE_URL must be https://<host> (no path)');
  process.exit(2);
}
const ACK = process.env.VERSION_CHANGE_ACKNOWLEDGED === '1';

const summary = [];
const say = (s = '') => { console.log(s); summary.push(s); };
const finish = (code, pending) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reverify_pending=${pending}\n`);
  process.exit(code);
};

/** This commit's catalogue, from the admin CLI of the freshly built bundle (no AWS access needed). */
function expectedCatalogue() {
  const out = execFileSync('node', ['dist-server/leaderboard/admin.mjs', 'missions'], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const physics = /^physics (\S+)$/.exec(lines[0] ?? '')?.[1];
  if (!physics) throw new Error(`unexpected admin.mjs output:\n${out}`);
  const missions = new Map(lines.slice(1).map((l) => { const [id, version] = l.split('\t'); return [id, String(version)]; }));
  return { physics, missions };
}

async function liveCatalogue() {
  const url = `${SITE_URL}/api/leaderboard/missions`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.physics || !Array.isArray(body.missions)) throw new Error(`GET ${url}: not a MissionsResponse`);
  return {
    physics: `${body.physics.model}.${body.physics.data}`,
    missions: new Map(body.missions.map((m) => [m.id, String(m.version)])),
  };
}

const want = expectedCatalogue();
let live;
try {
  live = await liveCatalogue();
} catch (e) {
  say('### Release gate: live leaderboard unreadable');
  say(`\`${e.message}\`. The gate cannot tell whether this commit changes the physics or a mission version, so nothing is deployed. Check the site, or deploy by hand (README, "Deploy by hand").`);
  finish(2, false);
}

const physicsChanged = want.physics !== live.physics;
const changed = [];
for (const [id, from] of live.missions) {
  const to = want.missions.get(id);
  if (to === undefined) changed.push({ id, from, to: '(removed)' });
  else if (to !== from) changed.push({ id, from, to });
}
const added = [...want.missions.keys()].filter((id) => !live.missions.has(id));

say(`### Release gate`);
say(`Physics: live \`${live.physics}\`, this commit \`${want.physics}\`${physicsChanged ? ' **(changed)**' : ''}`);
if (added.length) say(`New missions (no stored entries, nothing to re-verify): ${added.map((a) => `\`${a}\``).join(', ')}`);
if (!physicsChanged && changed.length === 0) {
  say('No physics or mission version change: safe to deploy automatically.');
  finish(0, false);
}

say('');
say(changed.length ? '| mission | live version | this commit |\n|---|---|---|' : '');
for (const c of changed) say(`| \`${c.id}\` | ${c.from} | ${c.to} |`);
say('');
say(physicsChanged || changed.length
  ? 'Deploying this commit empties the affected boards until the stored plans are re-verified with this build. The deploy role cannot write the table, so a person must run, with operator credentials, from this commit:'
  : '');
const cmds = ['pnpm build:leaderboard', 'export TABLE_NAME=<table>   # leaderboard stack output TableName', 'eval "$(aws configure export-credentials --profile <profile> --format env)"'];
const targets = physicsChanged
  ? [...want.missions.keys()].map((id) => ({ id, from: live.missions.get(id) !== want.missions.get(id) ? live.missions.get(id) : undefined }))
  : changed.filter((c) => c.to !== '(removed)');
for (const dry of [true, false]) {
  for (const t of targets) {
    if (live.missions.get(t.id) === undefined) continue;
    cmds.push(`node dist-server/leaderboard/admin.mjs reverify --mission ${t.id}${t.from ? ` --from ${t.from}` : ''}${dry ? ' --dry-run' : ''}`);
  }
}
cmds.push('# repeat each real run until it reports written: 0');
say('```sh');
for (const c of cmds) say(c);
say('```');
if (ACK) {
  say('**VERSION_CHANGE_ACKNOWLEDGED=1: deploying anyway. Re-verification is PENDING until the commands above have been run.**');
  finish(0, true);
}
say('**Stopped before deploying.** Either deploy by hand following the release notes in README.md (leaderboard, site, then the commands above), or run the Deploy workflow by hand with `version_change_acknowledged` checked and run the commands right after it.');
finish(1, false);
