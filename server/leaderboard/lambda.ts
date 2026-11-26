/**
 * Lambda entry point (bundled to dist-server/leaderboard/handler.mjs).
 *
 * Module scope is kept across warm invocations: the engine (ephemeris with the
 * checkpoint asset installed, and every ephemeris chunk built so far, LRU
 * bounded) is created once per execution environment. The checkpoint asset is
 * bundled next to this file as checkpoints.bin.
 */
import { configFromEnv } from './config';
import { credentialsFromEnv, HttpDynamo } from './dynamo';
import { createEngine } from './engine';
import { handle, type Role, type UrlEvent, type UrlResponse } from './http';
import { readAsset } from './node-io';
import { Service } from './service';
import { Store } from './store';

const config = configFromEnv(process.env);
const engine = createEngine({ checkpoints: await readAsset('checkpoints.bin', import.meta.url), maxChunks: Number(process.env.MAX_CHUNKS) || 160 });
const db = new HttpDynamo(config.region, () => credentialsFromEnv(process.env));
const service = new Service({ engine, store: new Store(db, config.table), config });
const role: Role = process.env.ROLE === 'submit' || process.env.ROLE === 'read' ? process.env.ROLE : 'all';

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
log({ level: 'info', msg: 'cold start', role, physics: engine.physicsVersion, missions: engine.missions().map((m) => `${m.id}@${m.version}`) });

export async function handler(ev: UrlEvent): Promise<UrlResponse> {
  return handle(service, ev, config.maxBodyBytes, log, role);
}
