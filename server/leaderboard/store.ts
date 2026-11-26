/**
 * Leaderboard storage on one DynamoDB table (on-demand) with three sparse GSIs.
 *
 * TABLE  pk (S), sk (S); TTL attribute `expiresAt` (epoch seconds).
 *
 *  Entry, one per player per mission version:
 *    pk = E#<mission>#<version>   sk = P#<playerHash>
 *    name, tag, pid, rev (optimistic-concurrency counter), hidden, created, updated
 *    c / d / t: the player's best result on the combined / delta-v / time board
 *       { score, deltaV, missionTime, at (ms), digest, planHash, physics, status, reason? }
 *    cPlan / dPlan / tPlan: the encoded plan of that result (for re-verification)
 *    cPk, cSk, cV / dPk, dSk, dV / tPk, tSk, tV: GSI keys and a compact copy of
 *       the slot's values ("score|deltaV|missionTime|at"), present only while
 *       that slot is valid and the entry is not hidden (sparse indexes)
 *       xPk = <mission>#<version>#<physicsVersion>, xSk = keys.ts sortKey
 *
 *  Score cache, one per (physics version, mission version, exact plan):
 *    pk = S#<sha256>  sk = '-'   verdict fields; expiresAt = +90 days
 *
 *  Rate counter, one per (who, window):
 *    pk = R#<p|ip>#<hash>#<window>#<bucket>  sk = '-'   n; expiresAt = window end + 60 s
 *
 * GSIs `combined`, `deltaV`, `time`: partition xPk, sort xSk, projection
 * INCLUDE name, tag, pid and that board's xV (index items stay ~0.4 KB, which
 * is what own-rank COUNT queries pay for per row). Because the physics version is
 * part of the GSI partition, entries verified under an older physics build
 * drop out of the boards the moment the server's physics version changes,
 * until re-verification rewrites them (reverify.ts).
 *
 * Every read is a GetItem or a Query on a known partition: no scans.
 */
import { DynamoError, marshalItem, unmarshalItem, type DynamoApi, type Item, type Plain } from './dynamo';
import { BOARDS, SLOT, type BoardId } from './keys';

export interface Slot {
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
  /** Submission time of this result, ms. */
  readonly at: number;
  /** Replay digest. */
  readonly digest: string;
  readonly planHash: string;
  /** Physics version this result was verified under. */
  readonly physics: string;
  readonly status: 'valid' | 'invalid';
  readonly reason?: string;
  /** Precomputed board sort key. */
  readonly key: string;
}

export interface Entry {
  readonly mission: string;
  readonly version: string;
  readonly playerHash: string;
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
  readonly hidden: boolean;
  readonly created: number;
  readonly updated: number;
  /** Incremented on every write; 0 for an entry not yet stored. */
  readonly rev: number;
  readonly slots: Partial<Record<BoardId, Slot>>;
  readonly plans: Partial<Record<BoardId, string>>;
}

export interface BoardRow {
  readonly pid: string;
  readonly name: string;
  readonly tag: string;
  readonly values: { readonly score: number; readonly deltaV: number; readonly missionTime: number; readonly at: number };
  readonly key: string;
}

export interface CachedVerdict {
  readonly status: string;
  readonly success: boolean;
  readonly score: number;
  readonly deltaV: number;
  readonly missionTime: number;
  readonly digest: string;
  readonly outcome: string;
  readonly reason: string;
  readonly objectives: readonly { kind: string; ok: boolean; detail: string }[];
}

export const INDEX: Record<BoardId, string> = { combined: 'combined', deltaV: 'deltaV', time: 'time' };

export function entryPk(mission: string, version: string): string {
  return `E#${mission}#${version}`;
}

export function boardPk(mission: string, version: string, physics: string): string {
  return `${mission}#${version}#${physics}`;
}

export class Store {
  constructor(private readonly db: DynamoApi, private readonly table: string) {}

  // ------------------------------------------------------------ rate limiting

  /**
   * Count one request against `key` in the current fixed window. Returns
   * false (and counts nothing) once `limit` requests were counted. One write.
   */
  async hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<boolean> {
    const bucket = Math.floor(nowMs / 1000 / windowSec);
    try {
      await this.db.send('UpdateItem', {
        TableName: this.table,
        Key: { pk: { S: `R#${key}#${windowSec}#${bucket}` }, sk: { S: '-' } },
        UpdateExpression: 'ADD #n :one SET #e = if_not_exists(#e, :exp)',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :lim',
        ExpressionAttributeNames: { '#n': 'n', '#e': 'expiresAt' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':lim': { N: String(limit) }, ':exp': { N: String((bucket + 1) * windowSec + 60) } },
      });
      return true;
    } catch (e) {
      if (e instanceof DynamoError && e.code === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  // ------------------------------------------------------------- score cache

  async getCached(hash: string): Promise<CachedVerdict | null> {
    const out = await this.db.send('GetItem', { TableName: this.table, Key: { pk: { S: `S#${hash}` }, sk: { S: '-' } } });
    const item = out.Item as Item | undefined;
    if (!item) return null;
    const o = unmarshalItem(item);
    return JSON.parse(String(o.v)) as CachedVerdict;
  }

  async putCached(hash: string, v: CachedVerdict, nowMs: number, ttlDays = 90): Promise<void> {
    await this.db.send('PutItem', {
      TableName: this.table,
      Item: marshalItem({ pk: `S#${hash}`, sk: '-', v: JSON.stringify(v), expiresAt: Math.floor(nowMs / 1000) + ttlDays * 86400 }),
    });
  }

  // ------------------------------------------------------------------ entries

  async getEntry(mission: string, version: string, playerHash: string): Promise<Entry | null> {
    const out = await this.db.send('GetItem', {
      TableName: this.table,
      Key: { pk: { S: entryPk(mission, version) }, sk: { S: `P#${playerHash}` } },
      ConsistentRead: true,
    });
    return out.Item ? entryOf(out.Item as Item) : null;
  }

  /** Write an entry if its stored rev is still `entry.rev` (or it does not exist and rev is 0). Returns false on a lost race. */
  async putEntry(entry: Entry): Promise<boolean> {
    const item = itemOf({ ...entry, rev: entry.rev + 1 });
    try {
      await this.db.send('PutItem', {
        TableName: this.table,
        Item: item,
        ConditionExpression: entry.rev === 0 ? 'attribute_not_exists(#pk)' : '#rev = :rev',
        ExpressionAttributeNames: entry.rev === 0 ? { '#pk': 'pk' } : { '#rev': 'rev' },
        ...(entry.rev === 0 ? {} : { ExpressionAttributeValues: { ':rev': { N: String(entry.rev) } } }),
      });
      return true;
    } catch (e) {
      if (e instanceof DynamoError && e.code === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  /** All entries of a mission version (admin / re-verification), page by page. */
  async *entries(mission: string, version: string): AsyncGenerator<Entry> {
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :p)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': { S: entryPk(mission, version) }, ':p': { S: 'P#' } },
        ConsistentRead: true,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      for (const i of (out.Items as Item[]) ?? []) yield entryOf(i);
      start = out.LastEvaluatedKey;
    } while (start);
  }

  /** Entry by public id (16 hex digits of the player hash). */
  async findByPid(mission: string, version: string, pid: string): Promise<Entry | null> {
    const out = await this.db.send('Query', {
      TableName: this.table,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :p)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': { S: entryPk(mission, version) }, ':p': { S: `P#${pid}` } },
      Limit: 2,
    });
    const items = (out.Items as Item[]) ?? [];
    return items.length === 1 ? entryOf(items[0]) : null;
  }

  // ------------------------------------------------------------------- boards

  /** Top rows of a board after `afterKey` (exclusive), best first. Eventually consistent. */
  async board(board: BoardId, pk: string, limit: number, afterKey?: string): Promise<BoardRow[]> {
    const s = SLOT[board];
    const out = await this.db.send('Query', {
      TableName: this.table,
      IndexName: INDEX[board],
      KeyConditionExpression: afterKey ? '#pk = :pk AND #sk > :after' : '#pk = :pk',
      ExpressionAttributeNames: { '#pk': `${s}Pk`, '#sk': `${s}Sk` },
      ExpressionAttributeValues: { ':pk': { S: pk }, ...(afterKey ? { ':after': { S: afterKey } } : {}) },
      ScanIndexForward: true,
      Limit: limit,
    });
    return ((out.Items as Item[]) ?? []).map((i) => {
      const o = unmarshalItem(i);
      const [score, deltaV, missionTime, at] = String(o[`${s}V`]).split('|').map(Number);
      return { pid: String(o.pid), name: String(o.name), tag: String(o.tag), values: { score, deltaV, missionTime, at }, key: String(o[`${s}Sk`]) };
    });
  }

  /**
   * Number of rows ranked above `key` on a board (so rank = count + 1),
   * counting at most `max` (null beyond). A COUNT query over the rows above:
   * its read cost grows with the rank (see infra/leaderboard.yaml notes).
   */
  async countAbove(board: BoardId, pk: string, key: string, max: number): Promise<number | null> {
    const s = SLOT[board];
    let n = 0;
    let start: unknown;
    do {
      const out = await this.db.send('Query', {
        TableName: this.table,
        IndexName: INDEX[board],
        KeyConditionExpression: '#pk = :pk AND #sk < :k',
        ExpressionAttributeNames: { '#pk': `${s}Pk`, '#sk': `${s}Sk` },
        ExpressionAttributeValues: { ':pk': { S: pk }, ':k': { S: key } },
        Select: 'COUNT',
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      n += Number(out.Count ?? 0);
      if (n > max) return null;
      start = out.LastEvaluatedKey;
    } while (start);
    return n;
  }
}

// ------------------------------------------------------------- item mapping

function itemOf(e: Entry): Item {
  const o: Record<string, Plain | undefined> = {
    pk: entryPk(e.mission, e.version),
    sk: `P#${e.playerHash}`,
    pid: e.pid,
    name: e.name,
    tag: e.tag,
    hidden: e.hidden,
    created: e.created,
    updated: e.updated,
    rev: e.rev,
  };
  for (const b of BOARDS) {
    const s = SLOT[b];
    const slot = e.slots[b];
    if (!slot) continue;
    o[s] = { ...slot } as unknown as Plain;
    const plan = e.plans[b];
    if (plan !== undefined) o[`${s}Plan`] = plan;
    if (slot.status === 'valid' && !e.hidden) {
      o[`${s}Pk`] = boardPk(e.mission, e.version, slot.physics);
      o[`${s}Sk`] = slot.key;
      o[`${s}V`] = `${slot.score}|${slot.deltaV}|${slot.missionTime}|${slot.at}`;
    }
  }
  return marshalItem(o);
}

function entryOf(i: Item): Entry {
  const o = unmarshalItem(i);
  const [, mission, version] = /^E#(.+)#([^#]+)$/.exec(String(o.pk)) ?? [];
  const slots: Partial<Record<BoardId, Slot>> = {};
  const plans: Partial<Record<BoardId, string>> = {};
  for (const b of BOARDS) {
    const s = SLOT[b];
    if (o[s]) slots[b] = o[s] as unknown as Slot;
    if (typeof o[`${s}Plan`] === 'string') plans[b] = o[`${s}Plan`] as string;
  }
  return {
    mission,
    version,
    playerHash: String(o.sk).slice(2),
    pid: String(o.pid),
    name: String(o.name),
    tag: String(o.tag),
    hidden: o.hidden === true,
    created: Number(o.created),
    updated: Number(o.updated),
    rev: Number(o.rev),
    slots,
    plans,
  };
}

