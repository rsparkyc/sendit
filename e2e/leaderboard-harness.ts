/**
 * The real leaderboard handler in-process for the browser tests: the HTTP
 * layer, service, store and the REAL engine (strict decoder, rules, real
 * ephemeris replay and objectives) over the in-memory DynamoDB fake the
 * server tests use. Nothing about the API's behaviour is mocked; variants
 * only change the mission catalogue or the deployment config, as a real
 * deployment could.
 *
 * Built by Vite (SSR, like .dist-node/ephemeris-digest.js) so JSON and the
 * mission code resolve exactly as in the server bundle.
 */
import type { Config } from '../server/leaderboard/config';
import { createEngine } from '../server/leaderboard/engine';
import { FakeDynamo, LEADERBOARD_INDEXES } from '../server/leaderboard/fake-dynamo';
import { handle } from '../server/leaderboard/http';
import { Service } from '../server/leaderboard/service';
import { Store } from '../server/leaderboard/store';
import { CONFIG } from '../server/leaderboard/test-kit';
import { CAMPAIGN } from '../src/mission/campaign';
import type { CompleteMission } from '../src/mission/objectives';

export type Variant = 'normal' | 'mission-updated' | 'stricter-rules' | 'stricter-objectives';

function catalogue(v: Variant): CompleteMission[] {
  return CAMPAIGN.map((m) => {
    if (m.id !== 'lunar-flyby') return m;
    switch (v) {
      case 'mission-updated':
        return { ...m, version: Number(m.version) + 1 }; // always newer than the page's copy
      case 'stricter-rules':
        return { ...m, rules: { ...m.rules, sites: ['cape-canaveral'] } };
      case 'stricter-objectives':
        return { ...m, objectives: [{ kind: 'flyby', body: 'moon', minAltitude: 100e3, maxAltitude: 500e3 }, ...m.objectives.slice(1)] };
      default:
        return m;
    }
  });
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function makeLeaderboard(checkpoints: Uint8Array, o: { variant?: Variant; config?: Partial<Config> } = {}) {
  const engine = createEngine({ checkpoints, catalogue: catalogue(o.variant ?? 'normal') });
  const config: Config = { ...CONFIG, ...o.config };
  const service = new Service({ engine, store: new Store(new FakeDynamo(LEADERBOARD_INDEXES), config.table), config });
  return async (method: string, url: string, headers: Record<string, string>, body: string | undefined): Promise<Reply> => {
    const u = new URL(url);
    const r = await handle(service, {
      rawPath: u.pathname,
      headers,
      queryStringParameters: Object.fromEntries(u.searchParams),
      body,
      isBase64Encoded: false,
      requestContext: { http: { method, sourceIp: '198.51.100.7' } },
    }, config.maxBodyBytes);
    return { status: r.statusCode, headers: r.headers, body: r.body };
  };
}
