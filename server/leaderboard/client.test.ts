/**
 * The browser client (src/leaderboard/client.ts) against the real handler
 * through a fetch stand-in: request / response shapes agree on both sides,
 * the secret is kept, errors and retries behave.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as client from '../../src/leaderboard/client';
import { encode, Harness, plan, TEST_MISSION } from './test-kit';

const V = String(TEST_MISSION.version);

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

/** fetch -> Harness.call, recording requests; `inject` can fail attempts first. */
function wire(h: Harness, inject: (n: number) => Response | Error | null = () => null) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init });
    const fault = inject(seen.length);
    if (fault instanceof Error) throw fault;
    if (fault) return fault;
    const u = new URL(url, 'https://site.invalid');
    const query = Object.fromEntries(u.searchParams);
    const headers = init.headers as Record<string, string>;
    const r = await h.call(init.method ?? 'GET', u.pathname, { raw: init.body as string | undefined, query, ip: '192.0.2.1', headers });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return { f: f as unknown as typeof fetch, seen };
}

describe('leaderboard client', () => {
  let store: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    store = memoryStorage();
    client.configure({ storage: store, retries: 2, sleep: async () => {} });
  });

  it('submits, reads boards and own ranks with a persistent secret, signing bodies with their SHA-256', async () => {
    const h = new Harness();
    const w = wire(h);
    client.configure({ fetch: w.f });
    const r = await client.submitFlight({ missionId: TEST_MISSION.id, missionVersion: V, plan: encode(plan(h.engine, { burns: [100] })), name: 'Ada' });
    expect(r.result.deltaV).toBe(1000);
    const secret = store.m.get(client.SECRET_KEY)!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.secretIsPersistent()).toBe(true);
    const post = w.seen[0];
    const sent = post.init.body as string;
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((post.init.headers as Record<string, string>)['x-amz-content-sha256']).toBe(sha);
    expect(JSON.parse(sent).secret).toBe(secret);
    expect(post.url).toBe('/api/leaderboard/submit');

    const b = await client.getBoard(TEST_MISSION.id, V, 'deltaV', { limit: 5 });
    expect(b.entries[0]).toMatchObject({ rank: 1, name: 'Ada', deltaV: 1000 });
    const me = await client.getMyRanks(TEST_MISSION.id, V);
    expect(me.player?.name).toBe('Ada');
    expect(me.ranks.deltaV?.rank).toBe(1);
    expect(store.m.get(client.SECRET_KEY)).toBe(secret); // same identity
  });

  it('reports version mismatches as such, and checks compatibility up front', async () => {
    const h = new Harness();
    client.configure({ fetch: wire(h).f });
    const e = await client.submitFlight({ missionId: TEST_MISSION.id, missionVersion: '1', plan: encode(plan(h.engine)), name: 'Ada' }).catch((x: unknown) => x);
    expect(client.isVersionMismatch(e)).toBe(true);
    expect((e as client.LeaderboardError).status).toBe(409);
    expect((e as client.LeaderboardError).detail).toEqual({ current: V });
    expect(await client.checkCompatible(TEST_MISSION.id, V, { model: h.engine.model, data: 'ffffffff' }, {})).toMatch(/out of date/);
    expect(await client.checkCompatible(TEST_MISSION.id, V, { model: h.engine.model, data: h.engine.fingerprint })).toBeNull();
  });

  it('retries network errors and 5xx, but not client errors', async () => {
    const h = new Harness();
    let w = wire(h, (n) => (n === 1 ? new TypeError('offline') : n === 2 ? new Response('{"error":"server-error","message":"x"}', { status: 500 }) : null));
    client.configure({ fetch: w.f });
    const ok = await client.submitFlight({ missionId: TEST_MISSION.id, missionVersion: V, plan: encode(plan(h.engine)), name: 'Ada' });
    expect(ok.player.name).toBe('Ada');
    expect(w.seen).toHaveLength(3);

    w = wire(h);
    client.configure({ fetch: w.f });
    const e = await client.submitFlight({ missionId: TEST_MISSION.id, missionVersion: V, plan: 'garbage', name: 'Ada' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(client.LeaderboardError);
    expect((e as client.LeaderboardError).code).toBe('invalid-plan');
    expect(w.seen).toHaveLength(1);

    w = wire(h, () => new TypeError('offline'));
    client.configure({ fetch: w.f });
    const n = await client.getBoard(TEST_MISSION.id, V, 'time').catch((x: unknown) => x);
    expect((n as client.LeaderboardError).code).toBe('network');
    expect(w.seen).toHaveLength(3);
  });

  it('keeps working without storage, and can move a secret between browsers', () => {
    client.configure({ storage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    const s = client.playerSecret();
    expect(client.playerSecret()).toBe(s);
    expect(client.secretIsPersistent()).toBe(false);
    client.configure({ storage: store });
    expect(client.importSecret('not valid')).toBe(false);
    const other = 'Q'.repeat(43);
    expect(client.importSecret(other)).toBe(true);
    expect(client.exportSecret()).toBe(other);
  });

  it('is not imported statically by any page module (loads only when used)', async () => {
    const { readdirSync, readFileSync } = (await import(/* @vite-ignore */ 'node:' + 'fs')) as {
      readdirSync(u: URL, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
      readFileSync(u: URL, e: 'utf8'): string;
    };
    const root = new URL('../../src/', import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(new URL(`${d.name}/`, dir));
        else if (/\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name) && !dir.pathname.endsWith('/leaderboard/')) {
          const src = readFileSync(new URL(d.name, dir), 'utf8');
          if (/^\s*import\s(?!type\s)[^;]*['"][^'"]*leaderboard\/client['"]/m.test(src)) offenders.push(d.name);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
