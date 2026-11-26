/**
 * Operator CLI (bundled to dist-server/leaderboard/admin.mjs). Talks to the
 * production table directly with the operator's own AWS credentials; there is
 * no admin HTTP endpoint.
 *
 *   node dist-server/leaderboard/admin.mjs missions
 *   node dist-server/leaderboard/admin.mjs reverify --mission <id> [--from <version>] [--force] [--dry-run]
 *   node dist-server/leaderboard/admin.mjs show   --mission <id> --version <v> --pid <pid>
 *   node dist-server/leaderboard/admin.mjs hide   --mission <id> --version <v> --pid <pid>
 *   node dist-server/leaderboard/admin.mjs unhide --mission <id> --version <v> --pid <pid>
 *
 * A player's entries for a mission version are a group (store.ts): the
 * all-sites entry and one entry per launch site. show prints all of them;
 * hide / unhide change every entry of the group in one transaction (a player
 * is hidden from every site board and the all-sites boards together).
 *
 * Environment: TABLE_NAME, AWS_REGION (default us-east-1), and credentials in
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, e.g.
 *   eval "$(aws configure export-credentials --profile <profile> --format env)"
 */
import { credentialsFromEnv, HttpDynamo } from './dynamo';
import { createEngine } from './engine';
import { readAsset } from './node-io';
import { withHidden } from './group';
import { reverify } from './reverify';
import { ALL, Store } from './store';

const out = (s: string) => process.stdout.write(`${s}\n`);

function args(argv: readonly string[]): { cmd: string; opt: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opt[a.slice(2)] = next; i++; } else opt[a.slice(2)] = true;
  }
  return { cmd, opt };
}

function need(opt: Record<string, string | true>, k: string): string {
  const v = opt[k];
  if (typeof v !== 'string') throw new Error(`--${k} <value> is required`);
  return v;
}

async function main(): Promise<void> {
  const { cmd, opt } = args(process.argv.slice(2));
  const engine = createEngine({ checkpoints: await readAsset('checkpoints.bin', import.meta.url) });
  if (cmd === 'missions') {
    out(`physics ${engine.physicsVersion}`);
    for (const m of engine.missions()) out(`${m.id}\t${m.version}\t${m.title}`);
    return;
  }
  if (cmd === 'help') {
    out('commands: missions | reverify --mission <id> [--from <v>] [--force] [--dry-run] | show|hide|unhide --mission <id> --version <v> --pid <pid>');
    return;
  }
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('TABLE_NAME is not set');
  const store = new Store(new HttpDynamo(process.env.AWS_REGION ?? 'us-east-1', () => credentialsFromEnv(process.env)), table);
  const missionId = need(opt, 'mission');
  const mission = engine.mission(missionId);

  if (cmd === 'reverify') {
    if (!mission) throw new Error(`mission ${missionId} is not in this build`);
    const from = typeof opt.from === 'string' ? opt.from : undefined;
    out(`re-verifying ${missionId} ${from ?? mission.version} -> ${mission.version} under physics ${engine.physicsVersion}${opt['dry-run'] ? ' (dry run)' : ''}`);
    const s = await reverify({ engine, store, mission, from, force: opt.force === true, dryRun: opt['dry-run'] === true, log: out });
    out(JSON.stringify(s));
    return;
  }

  const version = need(opt, 'version');
  const pid = need(opt, 'pid');
  const g = await store.findByPid(missionId, version, pid);
  if (!g) throw new Error('no such entry');
  const entries = [g.all, ...g.sites.values()].filter((e) => e !== null);
  if (cmd === 'show') {
    for (const e of entries) out(JSON.stringify({ ...e, site: e.site === ALL ? 'all' : e.site, plans: Object.keys(e.plans) }, null, 2));
    return;
  }
  if (cmd === 'hide' || cmd === 'unhide') {
    const ok = await store.putEntries(withHidden(g, cmd === 'hide', Date.now()));
    out(ok ? `${cmd === 'hide' ? 'hidden' : 'visible again'} on every board: ${entries[0].name}#${entries[0].tag} (${entries.length} entries)` : 'entry changed meanwhile; run again');
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
